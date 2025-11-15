const admin = require("firebase-admin");
const { importAliExpressProduct, firebaseAuthCallback } = require("./src/aliexpressAuth");

admin.initializeApp();

exports.importAliExpressProduct = importAliExpressProduct;
exports.firebaseAuthCallback = firebaseAuthCallback;
