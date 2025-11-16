const admin = require("firebase-admin");
const {
    importAliExpressProduct,
    aliexpressAuthRedirect,
    aliexpressAuthCallback
} = require("./src/aliexpressAuth");

admin.initializeApp();

exports.importAliExpressProduct = importAliExpressProduct;
exports.aliexpressAuthRedirect = aliexpressAuthRedirect;
exports.aliexpressAuthCallback = aliexpressAuthCallback;
