'use strict'

const _             = require('lodash')
const url           = require('url')
const path          = require('path')
const htmlEntities  = require('he')
const getSlug       = require('speakingurl')
const packer        = require('zip-stream')
const cheerio       = require('cheerio')
const archiver      = require('archiver')
const request       = require('request')
const createError   = require('http-errors')

const mail          = require('./mail')
const config        = require('./config')
const { Mailing }   = require('./models')
const h             = require( './helpers' )

//----- UTILS

function isHttpUrl( uri ) {
  return /^http/.test( uri )
}

function secureHtml(html) {
  // replace all tabs by spaces so `he` don't replace them by `&#x9;`
  // `he` is an HTML entity encoder/decoder
  html      = html.replace(/\t/g, ' ')
  html      = htmlEntities.encode(html, {
    useNamedReferences: true,
    allowUnsafeSymbols: true,
  })
  return html
}

//////
// MAIL
//////

async function send(req, res, next) {
  if (!req.xhr) return next(createError(501)) // Not Implemented
  const { isAdmin }     = req.user
  const { user, body }  = req
  const { mailingId }   = req.params
  const reqParams       = {
    where: {
      id: mailingId,
    },
  }
  if ( !isAdmin ) reqParams.where.groupId = req.user.groupId
  const mailing         = await Mailing.findOne( reqParams )

  if (!mailing) return next( createError(404) )
  const html            = secureHtml( body.html )
  const mailStatus      = await mail
  .send({
    to:       body.rcpt,
    replyTo:  user.email,
    subject:  config.emailOptions.testSubjectPrefix + mailing.name,
    html:     html,
  })

  res.send( `OK: ${mailStatus.response}` )
}

//////
// DOWNLOAD
//////

const imagesFolder = 'images'
// for doc see:
// https://github.com/archiverjs/node-archiver/blob/master/examples/express.js

async function zip(req, res, next) {
  const { isAdmin }     = req.user
  const { user, body }  = req
  const { mailingId }   = req.params
  const reqParams       = {
    where: {
      id: mailingId,
    },
  }
  if ( !isAdmin ) reqParams.where.groupId = req.user.groupId
  const mailing         = await Mailing.findOne( reqParams )

  if (!mailing) return next( createError(404) )
  const archive = archiver( 'zip' )
  let { html }  = body
  let $         = cheerio.load( html )
  let name      = getName( mailing.name )

  console.log('download zip', name)

  // keep a track of every images for latter download
  // be carefull to avoid data uri
  // relatives path are not handled:
  //  - the mailing should work also by email test
  //  - SO no need to handle them
  const $images     = $( 'img' )
  const imgUrls     = _.uniq( $images.map( (i, el) => $(el).attr('src') ).get().filter( isHttpUrl ) )
  const $background = $( '[background]' )
  const bgUrls      = _.uniq( $background.map( (i, el) => $(el).attr('background') ).get().filter( isHttpUrl ) )
  const $style      = $( '[style]' )
  const styleUrls   = []
  $style
  .filter( (i, el) => /url\(/.test($(el).attr('style')) )
  .each( (i, el) => {
    const urlReg    = /url\('?([^)']*)/
    const style     = $(el).attr('style')
    const result    = urlReg.exec( style )
    if ( result && result[1] && isHttpUrl( result[1] ) && !styleUrls.includes(result[1]) ) {
      styleUrls.push(result[1])
    }
  })
  const allImages   = _.uniq( [...imgUrls, ...bgUrls, ...styleUrls] )

  // change path to match downloaded images
  // Don't use Cheerio because:
  // - when exporting it's messing with ESP tags
  // - Cheerio won't handle IE comments
  const esc     = _.escapeRegExp
  allImages.forEach( imgUrl => {
    const escImgUrl   = esc( imgUrl )
    const relativeUrl = `${ imagesFolder }/${ getImageName(imgUrl) }`
    const search      = new RegExp( escImgUrl, 'g' )
    html              = html.replace( search, relativeUrl )
  })

  archive.on( 'error', next )

  // on stream closed we can end the request
  archive.on( 'end', () => {
    console.log( 'Archive wrote %d bytes', archive.pointer() )
    res.end()
  })

  // set the archive name
  res.attachment( `${name}.zip` )

  // this is the streaming magic
  archive.pipe( res )

  // Add html with relatives url
  archive.append(secureHtml(html), {
    name:   `${name}.html`,
    prefix: `${name}/`,
  })

  // Pipe all images BUT don't add errored images
  const imagesRequest = allImages.map( imageUrl => {
    const dfd         = h.defer()
    const imageName   = getImageName(imageUrl)
    const imgRequest  = request(imageUrl)
    imgRequest.on('response', response => {
      if (response.statusCode !== 200) return
      archive.append( imgRequest, {
        name:   imageName,
        prefix: `${name}/${imagesFolder}/`
      })
      dfd.resolve()
    })
    imgRequest.on('error', imgError => {
      console.log('[ZIP] error during downloading', imageUrl)
      console.log(imgError)
      // still resolve, just don't add this errored image to the archive
      dfd.resolve()
    })
    return dfd
  })

  // Wait for all images to be requested before closing archive
  const imagesRequestStatus  = await Promise.all( imagesRequest )
  archive.finalize()
}

function getName(name) {
  name = name || 'email'
  return getSlug(name.replace(/\.[0-9a-z]+$/, ''))
}

function getImageName(imageUrl) {
  return url
  .parse( imageUrl )
  .pathname
  .replace(/\//g, ' ')
  .trim()
  .replace(/\s/g, '-')
}

module.exports = {
  send: h.asyncMiddleware( send ),
  zip:  h.asyncMiddleware( zip ),
}
