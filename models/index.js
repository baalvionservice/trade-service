'use strict';
const { Sequelize } = require('sequelize');
const config = require('../config/appConfig');

const sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
    host: config.db.host,
    port: config.db.port,
    dialect: 'postgres',
    logging: config.env === 'development' ? console.log : false,
    define: {
        underscored: true,
        freezeTableName: true,
    },
});

const db = {};
db.Sequelize = Sequelize;
db.sequelize = sequelize;

db.User            = require('./users')(sequelize, Sequelize.DataTypes);
db.Organization    = require('./organizations')(sequelize, Sequelize.DataTypes);
db.Rfq             = require('./rfqs')(sequelize, Sequelize.DataTypes);
db.Deal            = require('./deals')(sequelize, Sequelize.DataTypes);
db.Order           = require('./orders')(sequelize, Sequelize.DataTypes);
db.Escrow          = require('./escrows')(sequelize, Sequelize.DataTypes);
db.Shipment        = require('./shipments')(sequelize, Sequelize.DataTypes);
db.Document        = require('./documents')(sequelize, Sequelize.DataTypes);
db.Payment         = require('./payments')(sequelize, Sequelize.DataTypes);
db.ComplianceCase  = require('./compliance')(sequelize, Sequelize.DataTypes);
db.Dispute         = require('./disputes')(sequelize, Sequelize.DataTypes);
db.Wallet          = require('./wallets')(sequelize, Sequelize.DataTypes);
db.Notification    = require('./notifications')(sequelize, Sequelize.DataTypes);
db.Listing         = require('./listings')(sequelize, Sequelize.DataTypes);

Object.values(db).forEach(model => {
    if (model && model.associate) model.associate(db);
});

module.exports = db;
