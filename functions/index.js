// functions/index.js (simplified for debugging)
const {onRequest} = require("firebase-functions/v2/https");

exports.helloWorld = onRequest((request, response) => {
  response.send("Hello from Firebase!");
});
