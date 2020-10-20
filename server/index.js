'use strict'

const qs = require('qs')
const url = require('url')
const path = require('path')
const c = require('chalk')
const express = require('express')
const bodyParser = require('body-parser')
const methodOverride = require('method-override')
const compression = require('compression')
const morgan = require('morgan')
const favicon = require('serve-favicon')
const cookieParser = require('cookie-parser')
const i18n = require('i18n')
const moment = require('moment')
const { inspect, promisify } = require('util')
const createError = require('http-errors')
const helmet = require('helmet')
const httpShutdown = require('http-shutdown')
const Redis = require('ioredis')
const Sequelize = require('sequelize')
const formattor = require('formattor')
const { merge, omit, floor } = require('lodash')
const { duration } = moment

const { defer } = require('./helpers')
const mail = require('./mail')

module.exports = _ => {
  const session = require('./session')
  const config = require('./config')

  //////
  // SERVICE CONFIG
  //////

  //----- SEQUELIZE – for PostgreSQL DB

  const sequelize = require('./models/db-connection')
  const models = require('./models')

  //----- REDIS – for sessions

  // same goes here…
  const redis = new Redis(config.redis)
  if (config.log.redis) {
    redis.monitor().then(monitor => {
      monitor.on('monitor', (time, args, source, database) => {
        console.log(time + ': ' + inspect(args))
      })
    })
  }

  //////
  // SERVER CONFIG
  //////

  const app = express()

  app.set('trust proxy', true)
  app.use(helmet())

  function forcessl(req, res, next) {
    if (req.header('x-forwarded-proto') === 'https') return next()
    res.redirect(301, `https://${config.host}${req.url}`)
  }

  if (config.forcessl) app.use(forcessl)

  app.use(
    bodyParser.json({
      limit: '5mb',
    })
  )
  app.use(
    bodyParser.urlencoded({
      limit: '5mb',
      extended: true,
    })
  )
  // enable other methods from request (PUT, DELETE…)
  app.use(methodOverride('_method', { methods: ['GET', 'POST'] }))
  app.use(compression())
  app.use(favicon(path.join(__dirname, '../res/favicon.png')))
  app.use(cookieParser())

  //----- TEMPLATES

  app.set('views', path.join(__dirname, './views'))
  app.set('view engine', 'pug')

  //----- STATIC

  const md5public = require('./md5public.json')
  const maxAge = config.isDev ? duration(30, 'minutes') : duration(1, 'years')
  const staticOptions = { maxAge: maxAge.as('milliseconds') }

  app.locals.md5Url = url => {
    // disable md5 on dev
    // better for hot reload
    if (config.isDev) return url
    if (url in md5public) url = `/${md5public[url]}${url}`
    return url
  }

  function removeHash(req, res, next) {
    const { md5 } = req.params
    const staticPath = req.url.replace(`/${md5}`, '')
    req._restoreUrl = req.url
    if (md5public[staticPath] === md5) {
      req.url = staticPath
      // we don't want statics to be cached by the browser if the md5 is invalid
      // pass it to the next static handler which doens't set cache
    } else {
      req._staticPath = staticPath
    }
    next()
  }

  function restoreUrl(req, res, next) {
    // - get here if static middleware fail to find the file
    // - even if the md5 is invalid we can guess that the file exists
    if (req._staticPath in md5public) {
      req.url = req._staticPath
      // - if not that mean we have an url for another ressource => restore the original url
    } else {
      console.log('[MD5] should be another ressource', req._restoreUrl)
      req.url = req._restoreUrl
    }
    next()
  }

  const statics = [
    // first parse the url
    removeHash,
    // then check all static locations
    express.static(path.join(__dirname, '../dist'), staticOptions),
    express.static(path.join(__dirname, '../res'), staticOptions),
    express.static(
      path.join(__dirname, '../node_modules/material-design-lite'),
      staticOptions
    ),
    express.static(
      path.join(
        __dirname,
        '../node_modules/material-design-icons-iconfont/dist'
      ),
      staticOptions
    ),
    // restore any url
    restoreUrl,
  ]

  app.get('/:md5([a-zA-Z0-9]{32})*', ...statics)

  // no-cache static backup:

  // compiled assets
  app.use(express.static(path.join(__dirname, '../dist')))
  // commited assets
  app.use(express.static(path.join(__dirname, '../res')))
  // libs
  app.use('/lib/skins', express.static(path.join(__dirname, '../res/skins')))
  app.use(
    express.static(path.join(__dirname, '../node_modules/material-design-lite'))
  )
  app.use(
    express.static(
      path.join(
        __dirname,
        '../node_modules/material-design-icons-iconfont/dist'
      )
    )
  )

  //----- DYNAMIC IMAGES
  // put before sessions

  const images = require('./images')

  app.param(['placeholderSize'], (req, res, next, placeholderSize) => {
    if (/(\d+)x(\d+)\.png/.test(placeholderSize)) return next()
    console.log('placeholder format INVALID', placeholderSize)
    next(createError(404))
  })

  app.get('/img/:imageName', images.read)
  app.get(
    '/placeholder/:placeholderSize',
    images.checkCache,
    images.placeholder
  )
  app.get(
    '/resize/:sizes/:imageName',
    images.checkCache,
    images.checkSizes,
    images.resize
  )
  app.get(
    '/cover/:sizes/:imageName',
    images.checkCache,
    images.checkSizes,
    images.cover
  )

  //----- SESSION & I18N
  // no sessions needed for assets

  session.init(app, redis)
  i18n.configure({
    locales: ['fr', 'en'],
    defaultLocale: 'fr',
    extension: '.js',
    cookie: 'mosaicobackend',
    objectNotation: true,
    directory: path.join(__dirname, './locales'),
  })
  app.use(i18n.init)

  //////
  // LOGGING
  //////

  function getIp(req) {
    if (req.ip) {
      var ip = /([\d\.]+)$/.exec(req.ip)
      if (!Array.isArray(ip)) return ''
      return ip[1]
    }
    return ''
  }

  function logRequest(tokens, req, res) {
    if (/\/img\//.test(req.path)) return
    var method = c.blue(tokens.method(req, res))
    var ips = getIp(req)
    ips = ips ? c.grey(`- ${ips} -`) : ''
    var url = c.grey(tokens.url(req, res))
    return `${method} ${ips} ${url}`
  }

  function logResponse(tokens, req, res) {
    var method = c.blue(tokens.method(req, res))
    var ips = getIp(req)
    ips = ips ? c.grey(`- ${ips} -`) : ''
    var url = c.grey(tokens.url(req, res))
    var status = tokens.status(req, res)
    var time = floor(tokens['response-time'](req, res) / 1000, 2)
    var statusColor =
      status >= 500
        ? 'red'
        : status >= 400
          ? 'yellow'
          : status >= 300
            ? 'cyan'
            : 'green'
    if (/\/img\//.test(req.path) && status < 400) return
    return `${method} ${ips} ${url} ${c[statusColor](status)} ${time}s`
  }
  app.use(morgan(logRequest, { immediate: true }))
  app.use(morgan(logResponse))

  //////
  // ROUTING
  //////

  const render = require('./render')
  const groups = require('./groups')
  const users = require('./users')
  const templates = require('./templates')
  const mailings = require('./mailings')

  const download = require('./download')

  const guard = session.guard

  //----- EXPOSE DATAS TO VIEWS

  app.locals._config = omit(config, ['_', 'configs', 'config'])

  app.locals.printJS = data => JSON.stringify(data, null, '  ')

  app.locals.formatDate = function formatDate(data) {
    var formatedDate = moment(data).format('DD/MM/YYYY HH:mm')
    return formatedDate === 'Invalid date' ? '' : formatedDate
  }

  function filterQuery(prefix, value) {
    if (value === '' || value === null || typeof value === 'undefined') return
    return value
  }

  app.locals.mergeQueries = function mergeQueries(route, _query, params = {}) {
    const parsedroute = url.parse(route)
    const initParams = parsedroute.query ? qs.parse(parsedroute.query) : {}
    route = parsedroute.pathname
    params = merge(initParams, _query, params)
    params = qs.stringify(params, { filter: filterQuery })
    return Object.keys(params).length ? `${route}?${params}` : route
  }

  app.locals.getSorting = function getSorting(key, currentSorting) {
    const sorting = {
      sort: key,
      dir: 'desc',
    }
    if (key !== currentSorting.sort) return sorting
    if (currentSorting.dir === 'asc')
      return {
        sort: null,
        dir: null,
      }
    sorting.dir = 'asc'
    return sorting
  }

  function brandColorsToCSS() {
    const { brand } = config
    const properties = Object.keys(brand).filter(k => /^color/.test(k))
    if (!properties.length) return false
    return properties.map(k => `--${k}: ${brand[k]};`).join('\n')
  }

  app.locals._brand = {
    colors: brandColorsToCSS(),
  }

  // those datas need to be refreshed on every request
  // and also not exposed to `app` but to `res` ^^
  app.use(function exposeDataToViews(req, res, next) {
    res.locals._query = req.query
    res.locals._path = req.originalUrl
    res.locals._user = req.user ? req.user : {}
    if (config.isDev) {
      res.locals._debug = JSON.stringify(
        {
          _user: res.locals._user,
          messages: req.session && req.session.flash,
          _config: app.locals._config,
          _query: res.locals._query,
        },
        null,
        '  '
      )
    }
    next()
  })

  //----- MORE I18N

  // take care of language query params
  // http://stackoverflow.com/questions/19539332/localization-nodejs-i18n
  app.use((req, res, next) => {
    if (req.query.lang) {
      res.setLocale(req.query.lang)
      res.cookie('mosaicobackend', req.query.lang, {
        maxAge: 900000,
        httpOnly: true,
      })
    }
    next()
  })

  //----- PARAMS CHECK
  // http://expressjs.com/en/api.html#app.param

  // regexp for checking valid postgreSQL Ids
  const dbIdRegexp = /^[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}$/
  app.param(
    ['groupId', 'userId', 'templateId', 'mailingId', 'postgreId'],
    checkPostgreId
  )
  function checkPostgreId(req, res, next, postgreId) {
    if (dbIdRegexp.test(postgreId)) return next()
    console.log('test postgreId INVALID', postgreId)
    next(createError(404))
  }

  app.param(['galleryType'], (req, res, next, galleryType) => {
    if (['mailing', 'template'].includes(galleryType)) return next()
    console.log('galleryType format INVALID', galleryType)
    next(createError(404))
  })

  app.param(['templateName'], (req, res, next, templateName) => {
    if (['tedc15', 'versafix-1'].includes(templateName)) return next()
    console.log('templateName format INVALID', templateName)
    next(createError(404))
  })

  // connection
  app.post(
    '/admin/login',
    session.authenticate('local', {
      successRedirect: '/admin',
      failureRedirect: '/admin/login',
      failureFlash: true,
      successFlash: true,
    })
  )
  app.get('/admin/login', render.adminLogin)
  app.get('/admin', guard('admin'), groups.list)
  // groups
  app.all('/groups*', guard('admin'))
  app.get('/groups/:groupId/new-user', users.new)
  app.get('/groups/:groupId/new-template', templates.new)
  app.get('/groups/:groupId?', groups.show)
  app.post('/groups/:groupId?', groups.update)
  app.get('/groups', groups.list)
  app.all('/users*', guard('admin'))
  // users
  app.get('/users/:userId/activate', users.activate)
  app.delete('/users/:userId', users.deactivate)
  app.get('/users/:userId/reset', users.adminResetPassword)
  app.get('/users/:userId', users.show)
  app.post('/users/:userId?', users.update)
  app.get('/users', users.list)

  app.get('/templates/select', guard('user'), templates.userList)
  app.get('/templates/:templateId/markup', guard('user'), templates.getMarkup)
  app.all('/templates*', guard('admin'))
  app.delete('/templates/:templateId', templates.remove)
  app.get('/templates/:templateId/render-markup', templates.renderMarkup)
  app.get(
    '/templates/:templateId/auto-upload/:templateName',
    templates.autoUpload
  )
  app.get(
    '/templates/:templateId/generate-previews',
    templates.generatePreviews
  )
  app.get('/templates/:templateId', templates.show)
  app.post('/templates/:templateId?', templates.update)
  app.get('/templates', templates.list)

  //----- CONNECTION

  app.post(
    '/login',
    session.authenticate('local', {
      successRedirect: '/',
      failureRedirect: '/login',
      failureFlash: true,
    })
  )
  app.get('/login', guard('no-session'), render.login)
  app.get('/forgot', guard('no-session'), render.forgot)
  app.post('/forgot', guard('no-session'), users.userResetPassword)
  app.get('/password/:token', guard('no-session'), users.showSetPassword)
  app.post('/password/:token', guard('no-session'), users.setPassword)
  app.get('/logout', guard('user'), session.logout)

  //----- MORE IMAGES

  app.delete('/img/:imageName', guard('user'), images.destroy)

  //----- UPLOADS

  app.all('/upload*', guard('user'))
  app.get('/upload/:galleryType/:postgreId', images.listImages)
  app.post('/upload/:galleryType/:postgreId', images.upload)

  //----- MAILINGS

  app.all('/mailings/:mailingId/transfer', guard('admin'))
  app.get('/mailings/:mailingId/transfer', mailings.transfer.get)
  app.post('/mailings/:mailingId/transfer', mailings.transfer.post)
  app.all('/mailings*', guard('user'))
  app.get('/mailings/:mailingId/duplicate', mailings.duplicate)
  app.post('/mailings/:mailingId/send', download.send)
  app.post('/mailings/:mailingId/zip', download.zip)
  app.get('/mailings/:mailingId', mailings.show)
  app.post('/mailings/:mailingId', mailings.update)
  app.post('/mailings', mailings.create)
  app.delete('/mailings', mailings.bulkRemove)
  app.patch('/mailings', mailings.updateLabels)
  app.get('/mailings', mailings.userList)

  app.get('/about', render.about)

  app.get('/', guard('user'), mailings.userList)

  //////
  // ERROR HANDLING
  //////

  // everyhting that go there without an error should be treated as a 404
  app.use((req, res, next) => {
    if (req.xhr) return res.status(404).send('not found')
    return res.status(404).render('error-404')
  })

  function isSequelizeError(err) {
    const { name } = err
    if (!name) return false
    return [
      'SequelizeUniqueConstraintError',
      'SequelizeValidationError',
    ].includes(name)
  }

  app.use((err, req, res, next) => {
    if (isSequelizeError(err)) {
      // fromPath is used for getting the form route, instead of the action
      const { fromPath } = req.query
      console.log('handle sequelize error', err.errors)
      console.log(inspect(err, { colors: true }))
      const sequelizeErrors = {}
      err.errors.forEach(sequelizeError => {
        const { path } = sequelizeError
        sequelizeErrors[path] = sequelizeError
      })
      req.flash('error', sequelizeErrors)
      console.log(req.originalUrl)
      return res.redirect(fromPath || req.originalUrl)
    }

    const status = err.status || err.statusCode || (err.status = 500)
    console.log('error handling', status)
    if (status >= 500) {
      console.log(inspect(err, { colors: true }))
      // console.log(util.inspect(err, {showHidden: true}))
      // console.trace(err)
    }

    // force status for morgan to catch up
    res.status(status)
    // different formating
    if (req.xhr) return res.send(err)
    if (status === 404) return res.render('error-404')
    if (!err.stacktrace) err.stacktrace = err.stack || new Error(err).stack
    return res.render('error-default', { err })
  })

  //////
  // LAUNCHING
  //////

  const application = defer()

  function startApplication() {
    // use httpShutdown for being sure that every connection are removed
    // https://github.com/thedillonb/http-shutdown
    // It's important for testing as we need to be sure every process are done…
    // …in order for tape to end properly
    const server = httpShutdown(
      app.listen(config.PORT, err => {
        const stop = (err = null) => {
          stopApplication(err, {
            mail,
            redis,
            sequelize,
            server,
          })
        }
        if (err) {
          console.log('error')
          return stop(err)
        }
        if (config.TEST)
          console.log(c.keyword('orange')('[SERVER] running in TEST mode'))
        console.log(
          c.green('[SERVER] listening on port'),
          c.cyan(server.address().port),
          c.green('on mode'),
          c.cyan(config.NODE_ENV)
        )

        if (config.debug) console.log(c.yellow('[DEBUG] is on'))

        server.on('close', _ => {
          console.log('[SERVER] close event')
          stop()
        })
        process.on('SIGTERM', _ => {
          console.log('[SERVER] sigterm')
          stop()
        })
        setTimeout(templates.startNightmare, 100)
        application.resolve(server)
      })
    )
  }

  const stopApplication = async (err = null, modules = {}) => {
    console.log('[SERVER] gracefully closing server…')
    const { mail, redis, sequelize, server } = modules
    const waitFor = []
    if (mail) waitFor.push(mail.transporter.close())
    if (redis) redis.disconnect()
    if (sequelize) waitFor.push(sequelize.close())
    if (server) server.emit('shutdown')
    if (err) application.reject(err)
    if (server) waitFor.push(templates.nightmareInstance.end())
    console.log(`waiting ${waitFor.length} to close`)
    await Promise.all(waitFor)
    if (server) server.emit('shutdown')
    // Process.exit is done by tape in test
    // still force close on error for tape to go crazy \m/ >_< \m/
    if (!config.TEST || err) {
      console.log('[SERVER] exiting process')
      process.exit()
    }
  }

  //----- WAIT FOR MAIN EXTERNAL SERVICES BEFORE BOOTING

  config.setup.then(async _ => {
    try {
      await mail.status()
      console.log(c.green('[EMAIL] transport mailing – SUCCESS'))
    } catch (err) {
      console.log(c.red('[EMAIL] transport mailing – ERROR'))
      return stopApplication(new Error('[EMAIL] transport mailing – ERROR'))
    }

    try {
      await redis.ping()
      console.log(c.green('[REDIS] connection – SUCCESS'))
    } catch (err) {
      console.log(c.red('[REDIS] connection – ERROR'))
      return stopApplication(new Error('[REDIS] connection – ERROR'), { mail })
    }

    try {
      await sequelize.authenticate()
      console.log(c.green('[DATABASE] connection – SUCCESS'))
    } catch (err) {
      console.log(c.red('[DATABASE] connection – ERROR'))
      return stopApplication(new Error('[DATABASE] connection – ERROR'), {
        mail,
        redis,
      })
    }

    try {
      await sequelize.sync()
      console.log(c.green('[DATABASE] sync – SUCCESS'))
    } catch (err) {
      console.log(c.red('[DATABASE] sync – ERROR'))
      return stopApplication(new Error('[DATABASE] sync – ERROR'), {
        mail,
        redis,
        sequelize,
      })
    }

    startApplication()
  })

  return application
}
