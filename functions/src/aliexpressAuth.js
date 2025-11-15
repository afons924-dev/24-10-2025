// functions/src/aliexpressAuth.js
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const crypto = require('crypto');
const fetch = require('node-fetch');


// Internal logic function, easier to test
const _importAliExpressProductLogic = async (data, context) => {
    // 1. Check for admin privileges
    if (!context.auth || !context.auth.token.isAdmin) {
        throw new HttpsError('permission-denied', 'Must be an administrative user to call this function.');
    }

    const { url } = data;
    if (!url) {
        throw new HttpsError('invalid-argument', 'The function must be called with one argument "url".');
    }

    // 2. Extract Product ID from URL
    const productIdMatch = url.match(/item\/(\d+)\.html/);
    if (!productIdMatch || !productIdMatch[1]) {
        throw new HttpsError('invalid-argument', 'Invalid AliExpress URL format.');
    }
    const productId = productIdMatch[1];

    // 3. Prepare API Request Parameters
    const APP_KEY = process.env.ALIEXPRESS_APP_KEY.trim();
    const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET.trim();
    const API_URL = "https://api-sg.aliexpress.com/sync";

    const params = {
        app_key: APP_KEY,
        format: 'json',
        method: 'aliexpress.ds.product.get',
        product_id: productId,
        sign_method: 'sha256',
        timestamp: Date.now(),
        v: '2.0',
    };

    // 4. Generate Signature
    const sortedKeys = Object.keys(params).sort();
    const signString = sortedKeys.map(key => `${key}${params[key]}`).join('');

    const hmac = crypto.createHmac('sha256', APP_SECRET);
    hmac.update(signString);
    params.sign = hmac.digest('hex').toUpperCase();

    // 5. Make the API Call
    const queryString = new URLSearchParams(params).toString();

    try {
        const response = await fetch(`${API_URL}?${queryString}`);
        const data = await response.json();

        if (data.error_response) {
            console.error("AliExpress API Error:", data.error_response);
            throw new HttpsError('internal', `AliExpress API Error: ${data.error_response.msg}`);
        }

        const result = data.aliexpress_ds_product_get_response?.result;
        if (!result) {
             console.error("Unexpected AliExpress API response structure:", data);
            throw new HttpsError('internal', 'Could not find product data in the AliExpress API response.');
        }

        // 6. Transform data to match the format expected by the frontend
        const transformedData = {
            name: result.ae_item_base_info_dto.subject,
            description: result.ae_item_base_info_dto.detail, // Note: This might be HTML
            price: parseFloat(result.ae_sku_dtos[0]?.offer_sale_price || '0'),
            images: result.ae_multimedia_info_dto.image_urls.split(';')
        };

        return transformedData;

    } catch (error) {
        console.error("Error calling AliExpress API:", error);
        if (error instanceof HttpsError) { // Re-throw HttpsError
            throw error;
        }
        throw new HttpsError('internal', 'An unexpected error occurred while fetching product data from AliExpress.');
    }
};

/**
 * Imports a product from AliExpress using the Dropshipping API.
 * This is an authenticated function, callable from the client-side admin panel.
 */
const importAliExpressProduct = onCall({ region: 'europe-west3', secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"] }, (request) => {
    return _importAliExpressProductLogic(request.data, { auth: request.auth });
});


/**
 * firebaseAuthCallback - separa o callback do Firebase/Google Auth (que envia ?token=...)
 * PARA NÃO CONFLITAR com o AliExpress callback.
 */
const firebaseAuthCallback = onRequest({region: 'europe-west3'}, (req, res) => {
  // Este endpoint só trata do token do Firebase/Google
  const token = req.query.token || req.body?.token;
  if (!token) {
    return res.status(400).send("Missing token");
  }
  // Processa o token (verifica, troca, etc). Exemplo:
  console.log("Received Firebase token (short log):", token.slice(0, 30) + "...");
  // Redirect para UI
  return res.redirect(`https://darkdesire.pt/firebase-auth-success`);
});

const exportsObject = {
    importAliExpressProduct,
    firebaseAuthCallback
};

// Conditionally export the internal function for testing
if (process.env.NODE_ENV === 'test') {
    exportsObject._importAliExpressProductLogic = _importAliExpressProductLogic;
}

module.exports = exportsObject;
