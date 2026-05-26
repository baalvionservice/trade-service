'use strict';
module.exports = (sequelize, DataTypes) => {
    // camelCase attributes + underscored:false so deal-room messages map 1:1 to
    // the frontend Message shape (id, dealId, sender, content, type, offerData, createdAt).
    const Message = sequelize.define('Message', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: { type: DataTypes.STRING, allowNull: false, defaultValue: 'T-DEMO' },
        dealId: { type: DataTypes.STRING, allowNull: false },
        sender: { type: DataTypes.STRING, defaultValue: 'system' },
        senderName: { type: DataTypes.STRING },
        content: { type: DataTypes.TEXT },
        type: { type: DataTypes.STRING, defaultValue: 'text' },
        offerData: { type: DataTypes.JSONB },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        schema: 'trade',
        tableName: 'chat_messages',
        underscored: false,
        timestamps: true,
    });

    return Message;
};
