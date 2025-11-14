const admin = require("firebase-admin");
const { aliexpressAuth, aliexpressOAuthCallback, firebaseAuthCallback } = require("./src/aliexpressAuth");

admin.initializeApp();

exports.aliexpressAuth = aliexpressAuth;
exports.aliexpressOAuthCallback = aliexpressOAuthCallback;
exports.firebaseAuthCallback = firebaseAuthCallback;
