const logger = require('./logger')
const search = require('../lib/search')
const db = require('../models')
const { GrowthEvent } = require('@origin/growth/src/resources/event')
const { GrowthEventTypes } = require('@origin/growth/src/enums')
const { checkEventsFreshness } = require('./utils')

const LISTING_EVENTS = [
  'ListingCreated',
  'ListingUpdated',
  'ListingWithdrawn',
  'ListingData',
  'ListingArbitrated'
]

const OFFER_EVENTS = [
  'OfferCreated',
  'OfferWithdrawn',
  'OfferAccepted',
  'OfferDisputed',
  'OfferRuling',
  'OfferFinalized',
  'OfferData'
]

function isListingEvent(eventName) {
  return LISTING_EVENTS.includes(eventName)
}

function isOfferEvent(eventName) {
  return OFFER_EVENTS.includes(eventName)
}

class MarketplaceEventHandler {
  constructor(config, contractContext) {
    this.config = config
    this.contractContext = contractContext
  }

  /**
   * Gets details about a listing from @origin/eventsource
   * @param {Object} log
   * @param {{blockNumber: number, logIndex: number}} blockInfo
   * @returns {Promise<{listing: Listing, seller: User}>}
   * @private
   */
  async _getListingDetails(log, blockInfo) {
    // Note: Passing blockInfo.blockNumber as an arg to the getListing call
    // ensures that we preserve listings version history if the listener is
    // re-indexing data. Otherwise all the listing version rows in the DB would
    // end up with the same data.
    const listing = await this.contractContext.eventSource.getListing(
      log.decoded.listingID,
      blockInfo.blockNumber
    )
    checkEventsFreshness(listing.events, blockInfo)

    return { listing }
  }

  /**
   * Gets details about an offer by calling @origin/eventsource
   * @param {Object} log
   * @param {{blockNumber: number, logIndex: number}} blockInfo
   * @returns {Promise<{listing: Listing, offer: Offer, seller: User, buyer: User}>}
   * @private
   */
  async _getOfferDetails(log, blockInfo) {
    const listing = this._getListingDetails(log, blockInfo)
    checkEventsFreshness(listing.events, blockInfo)
    const offer = await this.contractContext.eventSource.getOffer(
      log.decoded.listingID,
      log.decoded.offerID,
      blockInfo.blocknumber
    )
    checkEventsFreshness(offer.events, blockInfo)

    return {
      listing,
      offer: offer
    }
  }

  /**
   * Gets details about a listing or an offer by calling @origin/eventsource
   * @param {Object} log
   * @param {{blockNumber: number, logIndex: number}} blockInfo
   * @returns {Promise<
   *    {listing: Listing, seller: User}|
   *    {listing: Listing, offer: Offer, seller: User, buyer: User}>}
   * @private
   */
  async _getDetails(log, blockInfo) {
    if (isListingEvent(log.eventName)) {
      return this._getListingDetails(log, blockInfo)
    }
    if (isOfferEvent(log.eventName)) {
      return this._getOfferDetails(log, blockInfo)
    }
    throw new Error(`Unexpected event ${log.eventName}`)
  }

  /**
   * Indexes a listing in the DB and in ElasticSearch.
   * @param {Object} log
   * @param {Object} details
   * @returns {Promise<void>}
   * @private
   */
  async _indexListing(log, { listing }) {
    const userAddress = log.decoded.party
    const ipfsHash = log.decoded.ipfsHash

    // Data consistency: check listingId from the JSON stored in IPFS
    // matches with listingID emitted in the event.
    // TODO: use method utils/id.js:parseListingId
    const contractListingId = listing.id.split('-')[2]
    if (contractListingId !== log.decoded.listingID) {
      throw new Error(
        `ListingId mismatch: ${contractListingId} !== ${log.decoded.listingID}`
      )
    }

    logger.info(`Indexing listing in DB: \
      id=${listing.id} blockNumber=${log.blockNumber} logIndex=${log.logIndex}`)
    const listingData = {
      id: listing.id,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      status: listing.status,
      sellerAddress: listing.seller.id.toLowerCase(),
      data: listing
    }
    if (log.eventName === 'ListingCreated') {
      listingData.createdAt = log.date
    } else {
      listingData.updatedAt = log.date
    }
    await db.Listing.upsert(listingData)

    if (this.config.elasticsearch) {
      logger.info(`Indexing listing in Elastic: id=${listing.id}`)
      search.Listing.index(listing.id, userAddress, ipfsHash, listing)
    }
  }

  /**
   * Indexes an offer in the DB and in ElasticSearch.
   * @param {Object} log
   * @param {Object} details
   * @returns {Promise<void>}
   * @private
   */
  async _indexOffer(log, details) {
    const listing = details.listing
    const offer = details.offer
    logger.info(`Indexing offer in DB: id=${offer.id}`)
    const offerData = {
      id: offer.id,
      listingId: listing.id,
      status: offer.status,
      sellerAddress: listing.seller.id.toLowerCase(),
      buyerAddress: offer.buyer.toLowerCase(),
      data: offer
    }
    if (log.eventName === 'OfferCreated') {
      offerData.createdAt = log.date
    } else {
      offerData.updatedAt = log.date
    }
    await db.Offer.upsert(offerData)
  }

  /**
   * Records ListingCreated, ListingPurchased and ListingSold events
   * in the growth DB.
   * @param log
   * @param details
   * @param blockInfo
   * @returns {Promise<void>}
   * @private
   */
  async _recordGrowthEvent(log, details, blockInfo) {
    switch (log.eventName) {
      case 'ListingCreated':
        await GrowthEvent.insert(
          logger,
          details.listing.seller.id.toLowerCase(),
          GrowthEventTypes.ListingCreated,
          details.listing.id,
          { blockInfo },
          log.date
        )
        break
      case 'OfferFinalized':
        // Insert a ListingPurchased event on the buyer side and
        // a ListingSold event on the seller side.
        await GrowthEvent.insert(
          logger,
          details.offer.buyer.id.toLowerCase(),
          GrowthEventTypes.ListingPurchased,
          details.offer.id,
          { blockInfo },
          log.date
        )
        await GrowthEvent.insert(
          logger,
          details.listing.seller.id.toLowerCase(),
          GrowthEventTypes.ListingSold,
          details.offer.id,
          { blockInfo },
          log.date
        )
        break
    }
  }

  /**
   * Main entry point for the MarketplaceHandler.
   * @param log
   * @returns {Promise<
   *    {listing: Listing, seller: User}|
   *    {listing: Listing, offer: Offer, seller: User, buyer: User}>}
   */
  async process(log) {
    if (!this.config.marketplace) {
      return null
    }

    const blockInfo = {
      blockNumber: log.blockNumber,
      logIndex: log.logIndex
    }
    const details = await this._getDetails(log, blockInfo)

    // On both listing and offer event, index the listing.
    // Notes:
    //  - Reason for also re-indexing on offer event is that the listing data includes
    // list of all events relevant to the listing.
    //  - We index both in DB and ES. DB is the ground truth for data and
    // ES is used for full-text search use cases.
    await this._indexListing(log, details)

    // On offer event, index the offer in the DB.
    if (isOfferEvent(log.eventName)) {
      await this._indexOffer(log, details)
    }

    if (this.config.growth) {
      await this._recordGrowthEvent(log, details, blockInfo)
    }

    return details
  }

  webhookEnabled() {
    return this.config.marketplace
  }

  discordWebhookEnabled() {
    return this.config.marketplace
  }

  emailWebhookEnabled() {
    return false
  }

  gcloudPubsubEnabled() {
    return this.config.marketplace
  }
}

module.exports = MarketplaceEventHandler
