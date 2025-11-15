const admin = require("firebase-admin");
const { importAliExpressProduct } = require("./src/aliexpressAuth");

admin.initializeApp();

exports.importAliExpressProduct = importAliExpressProduct;
