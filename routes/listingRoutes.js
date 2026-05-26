'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listListings, getListing, createListing, updateListing, deleteListing,
} = require('../controller/listingController');

router.get('/',       listListings);
router.get('/:id',    getListing);
router.post('/',      authMiddleware, createListing);
router.patch('/:id',  authMiddleware, updateListing);
router.delete('/:id', authMiddleware, deleteListing);

module.exports = router;
