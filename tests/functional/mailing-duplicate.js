'use strict'

const test      = require('tape')

const {
  data,
  connectUser,
  connectAdmin,
  createTest  } = require('../_test-utils')

const T1 = 'MAILING – duplicate'
test( T1, createTest( false, async (t, nm) => {

  const t1 = await nm
    .use( connectUser() )
    .click( '.js-tbody-selection tr:first-child a[href$="/duplicate"]' )
    .wait('.mailing-list')
    .evaluate( () => {
      const originalName  = document.querySelector('.js-tbody-selection tr:nth-child(2) > td:nth-child(2) > a').textContent
      const copyName      = document.querySelector('.js-tbody-selection tr:nth-child(1) > td:nth-child(2) > a').textContent
      return { originalName, copyName }
    })

  const { originalName,  copyName } = t1
  t.equal(copyName, `${originalName} copy`, `${T1} – same name + copy suffix`)

}))
