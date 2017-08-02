'use strict'

const _           = require( 'lodash' )
const qs          = require( 'qs' )
const { inspect } = require( 'util' )
const createError = require( 'http-errors' )
const moment      = require( 'moment' )
const { Types }   = require( 'mongoose' )

const config        = require( '../config' )
const filemanager   = require( '../filemanager' )
const models        = require( '../models' )
const {
  Template,
  Mailing,
  Galleries,
  User,
  Tag,
  addGroupFilter,
  addStrictGroupFilter,
}                         = models
const cleanTagName        = require( '../../shared/clean-tag-name' )
const h                   = require( '../helpers' )
const transfer            = require( './transfer' )

const translations  = {
  en: JSON.stringify(_.assign(
    {},
    require('../../res/lang/mosaico-en.json'),
    require('../../res/lang/custom-en')
  )),
  fr: JSON.stringify(_.assign(
    {},
    require('../../res/lang/mosaico-fr.json'),
    require('../../res/lang/custom-fr')
  )),
}

//////
// HOME LISTING
//////

const perpage = 25

async function userList(req, res, next) {
  const { query, user}        = req
  const { isAdmin, groupId }  = user

  //----- SORTING

  const order = []
  if ( query.sort ) {
    const { sort, dir }       = query
    const isRelationOrdering  = /^[A-Z][a-z]+\.[A-Za-z]+$/.test( sort )
    const field               = isRelationOrdering ? sort.split('.')[ 1 ] : sort
    const rowOrdering         = [ field, dir.toUpperCase() ]
    if ( isRelationOrdering ) rowOrdering.unshift( models[sort.split('.')[ 0 ]] )
    order.push( rowOrdering )
  } else {
    order.push( ['updatedAt', 'DESC'] )
  }

  //----- PAGINATION

  const limit   = query.limit ? ~~query.limit : perpage
  const page    = query.page ? ~~query.page - 1 : 0
  const offset  = page * limit

  //----- FILTERING

  // CLEANING QUERY

  // remove empty fields
  let filterQuery = _.pick( query, ['name', 'userId', 'templateId', 'createdAt', 'updatedAt', 'tags'] )
  ;['createdAt', 'updatedAt'].forEach( key => {
    if (!query[key]) return
    filterQuery[ key ]  = _.omitBy( filterQuery[ key ], value => value === '' )
  })
  filterQuery           = _.omitBy( filterQuery, value => {
    const isEmptyString = value === ''
    const isEmptyObject = _.isPlainObject(value) && Object.keys(value) < 1
    return isEmptyString || isEmptyObject
  } )

  const filterKeys    = Object.keys( filterQuery )

  // normalize array
  let arrayKeys = ['userId', 'templateId', 'tags']
  arrayKeys     = _.intersection( arrayKeys, filterKeys )
  for (let key of arrayKeys) {
    filterQuery[ key ] = _.concat( [], filterQuery[ key ] )
  }

  // CONSTRUCT FILTER
  const where = {
    groupId: isAdmin ? { $eq: null }  : groupId,
  }

  if (filterQuery.name) where.name = { $regexp: filterQuery.name }
  // SELECT
  // don't put tags filter in the mailing model
  arrayKeys.forEach( keys => {
    if (keys === 'tags') return
    where[ keys ] = { $in: filterQuery[ keys ] }
  })
  // DATES
  // for…of breaks on return, use forEach
  const datesFilterKeys = _.intersection( ['createdAt', 'updatedAt'], filterKeys )
  datesFilterKeys.forEach( key => {
    const rangeKeys = _.intersection( ['$lte', '$gte'], Object.keys( filterQuery[key] ) )
    rangeKeys.forEach( range => {
      // force UTC time for better comparison purpose
      const date = moment(`${filterQuery[key][range]} +0000`, 'YYYY-MM-DD Z')
      if (!date.isValid()) return
      // day begin at 00h00… go to the next ^^
      if (range === '$lte') date.add(1, 'days')
      where[key]         = where[key] || {}
      where[key][range]  = date.toDate()
    })
  })

  // RELATIONS
  // declare them here for better handling of filtering
  const userInclude     = {
    model:    User,
    required: false,
  }
  const TemplateInclude = {
    model:    Template,
    required: true,
  }
  const tagInclude      =  {
    model:    Tag,
    required: false,
  }

  // add tags filter in the tag relation
  if ( filterQuery.tags && filterQuery.tags.length ) {
    tagInclude.required = true
    tagInclude.where    = {
      name: { $in: filterQuery.tags },
    }
  }

  //----- CREATE DB QUERIES

  const mailingsParams        = {
    where,
    order,
    limit,
    offset,
    include: [
      userInclude,
      TemplateInclude,
      tagInclude,
    ],
  }
  const queries = [
    Mailing.findAndCount( mailingsParams ),
    Template.findAll( isAdmin ? {} : {where: { groupId}} ),
    isAdmin ? Promise.resolve( false ) : User.findAll( {where: { groupId }} ),
    Tag.findAll( {where: { groupId: isAdmin ? { $eq: null }  : groupId }} ),
  ]
  const [
    mailings,
    templates,
    users,
    tags,
  ]             = await Promise.all( queries )

  // PAGINATION STATUS
  const total         = mailings.count
  const isFirst       = page === 0
  const isLast        = page >= Math.trunc(total / limit)
  const pagination    = {
    total,
    current: `${offset + 1}-${offset + mailings.rows.length}`,
    prev:     isFirst ? false : page,
    next:     isLast  ? false : page + 2
  }

  // SUMMARY STATUS

  // “translate” ids: need users & templates in order to compute
  let idToName = ['userId', 'templateId']
  idToName     = _.intersection( idToName, filterKeys )
  for (let key of idToName) {
    const dataList = key === 'userId' ? users : templates
    filterQuery[ key ] = filterQuery[ key ].map( id => {
      return _.find( dataList, value => `${value.id}` === id ).name
    } )
  }

  // format for view
  const i18nKeys = {
    name:       'filter.summary.contain',
    userId:     'filter.summary.author',
    templateId: 'filter.summary.template',
    createdAt:  'filter.summary.createdat',
    updatedAt:  'filter.summary.updatedat',
    tags:       'filter.summary.tags',
  }
  const summary   = []
  _.forIn( filterQuery, (value, key) => {
    let i18nKey = i18nKeys[ key ]
    if ( _.isString(value) ) return summary.push( { message: i18nKey, value} )
    if ( _.isArray(value) ) {
      return summary.push( { message: i18nKey, value: value.join(', ')} )
    }
    // dates…
    summary.push( { message: i18nKey } )
    if (value.$gte) {
      summary.push( {
        message: 'filter.summary.after',
        value:    value.$gte
      } )
    }
    if (value.$gte && value.$lte ) {
      summary.push( {
        message: 'filter.summary.and',
      } )
    }
    if (value.$lte) {
      summary.push( {
        message: 'filter.summary.before',
        value:    value.$lte
      } )
    }
  })

  // FINALLY RENDER \o/
  const data    = {
    mailings: mailings.rows,
    users,
    templates,
    tagsList: tags,
    // tagsList:  tags.map( t => t._id ),
    pagination,
    filterQuery,
    summary,
  }
  // console.log( inspect(data, {depth: 1}), )

  res.render('mailing-list', { data } )

}

//////
// EDITOR
//////

async function show(req, res, next) {
  const { isAdmin }     = req.user
  const { mailingId }   = req.params
  const data            = {
    translations: translations[ res.getLocale() ],
  }
  const reqParams       = {
    where: {
      id: mailingId,
    },
    include: [{
      model:    User,
      required: false,
    }, {
      model:    Template,
      required: false,
    }],
  }
  if ( !isAdmin ) reqParams.where.groupId = req.user.groupId
  const mailing         = await Mailing.findOne( reqParams )
  if ( !mailing ) return next( createError(404) )
  res.render('mailing-edit', {
    data: _.assign( {}, data, mailing.mosaico)
  })
}

//////
// NEW MAILING
//////

async function create(req, res, next) {
  const { isAdmin }     = req.user
  const { templateId }  = req.query
  const reqParams       = {
    where: {
      id: templateId,
    },
  }
  if ( !isAdmin ) reqParams.where.groupId = req.user.groupId
  const template        = await Template.findOne( reqParams )
  if ( !template ) return next( createError(404) )
  const initParameters  = {
    // Always give a default name: needed for ordering & filtering
    // use res.__ because (not req) it's where i18n is always up to date (index.js#192)
    name:         res.__('home.saved.noname'),
    templateId:   templateId,
  }
  // admin doesn't have valid user id & group
  if (!req.user.isAdmin) {
    initParameters.userId  = req.user.id
    initParameters.groupId = req.user.groupId
  }
  const mailing           = await Mailing.create( initParameters )
  res.redirect( mailing.url.update )
}

//////
// BULK ACTIONS
//////

function getRedirectUrl(req) {
  const query       = qs.stringify( _.omit(req.query, ['_method']) )
  const redirectUrl = query ? `/?${query}` : '/'
  return redirectUrl
}

async function updateLabels(req, res, next) {
  const { isAdmin, groupId }  = req.user
  const { body }              = req
  const tagRegex              = /^tag-/
  const redirectUrl           = getRedirectUrl( req )
  if (!_.isArray( body.mailings ) || !body.mailings.length ) return res.redirect( redirectUrl )

  const allTags       = []
  const tagsToAdd     = []
  const tagsToRemove  = []
  Object.entries( body )
  .filter( ([tagName, action]) => tagRegex.test( tagName ) )
  .forEach( ([tagName, action]) => {
    if (action === 'unchange') return
    const cleanedName = tagName.replace(tagRegex, '')
    allTags.push( cleanedName )
    action            = action === 'add' ? tagsToAdd : tagsToRemove
    action.push( cleanedName )
  } )

  const mailingsParams  = {
    where: {
      groupId: isAdmin ? { $eq: null }  : groupId,
      id: {
        $in: body.mailings,
      },
    },
    attributes: [ 'id' ],
  }
  const mailings        = await Mailing.findAll( mailingsParams )

  if ( !mailings.length ) return res.redirect( redirectUrl )
  const mailingsId      = mailings.map( mailing => mailing.id )
  const tagsRequest     = allTags.map( async name => {
    const params          = { name }
    if ( !isAdmin ) params.groupId = groupId
    const [tag, created]  = await Tag.findCreateFind( {
      where:    params,
      default:  params,
    } )
    return tag
  })
  const dbTags          = await Promise.all( tagsRequest )

  const relationQUery   = dbTags.map( tag => {
    const method = tagsToAdd.includes( tag.name ) ? 'addMailings' : 'removeMailings'
    return tag[ method ]( mailingsId )
  })

  const updatedTags     = await Promise.all( relationQUery )
  res.redirect( redirectUrl )
}

async function bulkRemove(req, res, next) {
  const { isAdmin }     = req.user
  const { mailings }    = req.body
  if (!_.isArray( mailings ) || !mailings.length ) return res.redirect( redirectUrl )
  const redirectUrl     = getRedirectUrl( req )
  const reqParams       = {
    where: {
      id: {
        $in: mailings,
      }
    }
  }
  if ( !isAdmin ) reqParams.where.groupId = req.user.groupId
  const deleted         = await Mailing.destroy( reqParams )
  res.redirect( redirectUrl )
}

//////
// OTHERS ACTIONS
//////

async function update(req, res, next) {
  if (!req.xhr) return next( createError(501) ) // Not Implemented

  const { isAdmin }     = req.user
  const { mailingId }   = req.params
  const reqParams       = {
    where: {
      id: mailingId,
    },
    include: [{
      model:    User,
      required: false,
    }, {
      model:    Template,
      required: false,
    }],
  }

  if ( !isAdmin ) reqParams.where.groupId = req.user.groupId
  const mailing        = await Mailing.findOne( reqParams )

  if (!mailing) return next( createError(404) )
  mailing.data = req.body.data || mailing.data
  // use res.__ because (not req) it's where i18n is always up to date (index.js#192)
  mailing.name = h.normalizeString( req.body.name ) || res.__('home.saved.noname')

  const updatedMailing = await mailing.save()
  res.json( updatedMailing.mosaico )
}

// TODO while duplicating we should copy only the used images by the mailing
function duplicate(req, res, next) {
  const { mailingId }    = req.params

  Promise
  .all([
    Mailing.findOne( addGroupFilter(req.user, { _id: mailingId }) ),
    Galleries.findOne( { mailingOrTemplateId: mailingId } ),
  ])
  // Be sure that all images are duplicated before saving the duplicated mailing
  .then( duplicateImages )
  .then( saveMailing )
  .then( redirectToHome )
  .catch( err => {
    if (err.responseSend) return
    next( err )
  } )

  function duplicateImages( [mailing, gallery] ) {
    if (!mailing) {
      next( createError(404) )
      // Early return out of the promise chain
      return Promise.reject( {responseSend: true} )
    }
    const duplicatedMailing = mailing.duplicate( req.user )
    return Promise.all([
      duplicatedMailing,
      gallery,
      filemanager.copyImages( req.params.mailingId, duplicatedMailing._id ),
    ])
  }

  function saveMailing( [duplicatedMailing, gallery] ) {
    return Promise.all( [duplicatedMailing.save(), gallery ])
  }

  function redirectToHome( [duplicatedMailing, gallery] ) {
    res.redirect('/')
    // if gallery can't be created it's not a problem
    // it will be created when opening the duplicated mailing
    // we only loose hidden images
    if ( gallery ) gallery.duplicate( duplicatedMailing._id ).save()
  }

}

module.exports = {
  userList:     h.asyncMiddleware( userList ),
  show:         h.asyncMiddleware( show ),
  update:       h.asyncMiddleware( update ),
  updateLabels: h.asyncMiddleware( updateLabels ),
  bulkRemove:   h.asyncMiddleware( bulkRemove ),
  create:       h.asyncMiddleware( create ),
  duplicate,
}