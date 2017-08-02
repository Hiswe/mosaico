'use strict'

const Sequelize = require( 'sequelize' )

const sequelize = require( './db-connection' )
const h         = require( '../helpers' )

const Group     = sequelize.define( 'group', {
  id: {
    type:         Sequelize.UUID,
    defaultValue: Sequelize.UUIDV4,
    primaryKey:   true,
  },
  name: {
    type:         Sequelize.STRING,
    allowNull:    false,
    unique:       true,
    set:          function (val) {
      this.setDataValue('name', h.normalizeString( val ) )
    }
  },
  // VIRTUALS
  url: {
    type: new Sequelize.VIRTUAL(Sequelize.JSON, ['id']),
    get: function() {
      const id    = this.get('id')
      const urls  = {
        show:         `/groups/${id}`,
        delete:       `/groups/${id}/delete`,
        newUser:      `/groups/${id}/new-user`,
        newTemplate:  `/groups/${id}/new-template`,
      }
      return urls
    }
  },
})

Group.findByIdAndUpdate = async function( id, params ) {
  // https://medium.com/@griffinmichl/async-await-with-ternary-operators-af19f374215
  const group = await ( id ? this.findById(id) : new Group() )
  if ( !id & !group   ) return null
  return group.update( params )
}

module.exports = Group