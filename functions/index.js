const functions = require("firebase-functions");
const admin = require("firebase-admin");
const renderer = require("./renderer");
const axios = require("axios");

// Initialize the application
admin.initializeApp();
const db = admin.firestore();
renderer.init(db);


// TODO: Replace "https://your-production-domain.com" with your actual website's domain.
// The localhost domains are for local development and testing with the Firebase Emulator Suite.
const allowedOrigins = [
    "https://desire-loja-final.web.app",
    "https://darkdesire.pt",
    "http://localhost:5000",
    "http://127.0.0.1:5000"
];

const cors = require("cors")({
    origin: (origin, callback) => {
        // For local development, allow requests with no origin (e.g., from Postman, curl)
        if (!origin && (process.env.FUNCTIONS_EMULATOR === 'true' || process.env.NODE_ENV === 'development')) {
            return callback(null, true);
        }
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        } else {
            return callback(new Error("The CORS policy for this site does not allow access from the specified origin."));
        }
    }
});

// It is best practice to store sensitive keys in environment variables.
let stripe;
try {
    // Attempt to initialize Stripe with the secret key from Firebase config.
    const stripeConfig = functions.config().stripe;
    if (!stripeConfig || !stripeConfig.secret) {
        console.error("Stripe secret key is not configured properly in Firebase config (stripe.secret).");
    }
    stripe = require("stripe")(stripeConfig.secret);
} catch (error) {
    // If config is not available (e.g., during local analysis by Firebase CLI),
    // initialize with a dummy key to allow deployment to proceed.
    // This should not happen in a real production environment.
    console.warn("Stripe config not found, using a dummy key for analysis. Ensure config is set for production.");
    stripe = require("stripe")("sk_test_123456789012345678901234567890123456789012345678901234567890");
}

/**
 * Creates a Stripe Payment Intent.
 * This is called by the client-side to initialize the payment flow.
 * It now securely calculates the total on the server-side and uses a temporary
 * Firestore document to pass cart data, avoiding metadata limits.
 */
exports.createStripePaymentIntent = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        const { userId, cart } = req.body;

        if (!userId || !cart || !Array.isArray(cart) || cart.length === 0) {
            res.status(400).send({ error: "Missing or invalid parameters: userId and cart are required." });
            return;
        }

        try {
            // Calculate total amount on the server by fetching prices from Firestore
            let amount = 0;
            for (const item of cart) {
                const productRef = db.collection("products").doc(item.id);
                const productDoc = await productRef.get();
                if (productDoc.exists) {
                    amount += productDoc.data().price * item.quantity;
                }
            }
            const amountInCents = Math.round(amount * 100);

            // Ensure the amount is above Stripe's minimum
            if (amountInCents < 50) { // €0.50 minimum
                res.status(400).send({ error: `Amount is too small. Minimum charge is €0.50. Amount calculated: €${amount.toFixed(2)}` });
                return;
            }

            // Create the Payment Intent with the server-calculated amount
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amountInCents,
                currency: "eur",
                payment_method_types: ['card'],
                metadata: { userId } // Only store userId in metadata
            });

            // Store the cart details in a temporary Firestore document
            const sessionRef = db.collection('stripe_sessions').doc(paymentIntent.id);
            await sessionRef.set({
                userId,
                cart,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            res.status(200).send({
                clientSecret: paymentIntent.client_secret,
            });
        } catch (error) {
            console.error("Stripe Payment Intent creation failed:", error);
            res.status(500).send({ error: "Failed to create Stripe Payment Intent." });
        }
    });
});

/**
 * Fulfills an order by creating it in Firestore and updating stock.
 * This function is called by the Stripe webhook when a payment is successful.
 */
const fulfillOrder = async (paymentIntent) => {
    const sessionRef = db.collection('stripe_sessions').doc(paymentIntent.id);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
        console.error(`Could not find session for payment intent: ${paymentIntent.id}`);
        return;
    }

    const { userId, cart } = sessionDoc.data();

    if (!userId || !cart || !Array.isArray(cart) || cart.length === 0) {
        console.error("Invalid session data from payment intent:", paymentIntent.id);
        return;
    }

    const orderRef = db.collection("orders").doc();
    const userRef = db.collection("users").doc(userId);

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error(`User ${userId} not found.`);
            }
            const userProfile = userDoc.data();

            const productRefs = cart.map(item => db.collection("products").doc(item.id));
            const productDocs = await transaction.getAll(...productRefs);
            const fullCartItems = [];
            const productUpdates = [];

            for (let i = 0; i < cart.length; i++) {
                const productDoc = productDocs[i];
                if (!productDoc.exists) {
                    throw new Error(`Product with ID ${cart[i].id} not found.`);
                }
                const productData = productDoc.data();
                const cartItem = cart[i];

                if (productData.stock < cartItem.quantity) {
                    throw new Error(`Stock insufficient for ${productData.name}.`);
                }
                const newStock = productData.stock - cartItem.quantity;
                const newSoldCount = (productData.sold || 0) + cartItem.quantity;
                productUpdates.push({ ref: productDoc.ref, data: { stock: newStock, sold: newSoldCount } });

                fullCartItems.push({
                    ...cartItem,
                    name: productData.name,
                    price: productData.price,
                    image: (productData.images && productData.images[0]) || productData.image || ''
                });
            }

            const total = paymentIntent.amount / 100;
            const pointsToAward = Math.floor(total);

            const orderData = {
                userId: userId,
                items: fullCartItems,
                total: total,
                paymentIntentId: paymentIntent.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                shippingAddress: userProfile.address,
                status: 'Em processamento'
            };
            transaction.set(orderRef, orderData);

            productUpdates.forEach(update => transaction.update(update.ref, update.data));

            const newPoints = (userProfile.loyaltyPoints || 0) + pointsToAward;
            transaction.update(userRef, { loyaltyPoints: newPoints, cart: [] });
        });

        // Delete the temporary session document
        await sessionRef.delete();

        // Send confirmation emails
        const userDoc = await userRef.get();
        if (userDoc.exists) {
            const userProfile = userDoc.data();
            const total = paymentIntent.amount / 100;
            const mailCollection = db.collection("mail");

            await mailCollection.add({
                to: userProfile.email,
                message: {
                    subject: `Confirmação da sua encomenda #${orderRef.id}`,
                    html: `<h1>Obrigado pela sua encomenda!</h1><p>Olá ${userProfile.firstName || ''},</p><p>A sua encomenda com o ID #${orderRef.id} foi recebida e está a ser processada.</p><p>Total: €${total.toFixed(2)}</p><p>Obrigado por comprar na Desire!</p>`,
                },
            });

            const ADMIN_EMAIL = "your-admin-email@example.com";
            await mailCollection.add({
                to: ADMIN_EMAIL,
                message: {
                    subject: `Nova Venda! Encomenda #${orderRef.id}`,
                    html: `<h1>Nova Venda Recebida</h1><p>Encomenda #${orderRef.id} no valor de €${total.toFixed(2)} foi recebida de ${userProfile.email}.</p>`,
                },
            });
        }

        console.log(`Successfully fulfilled order for Payment Intent: ${paymentIntent.id}`);
    } catch (error) {
        console.error(`Error fulfilling order for Payment Intent ${paymentIntent.id}:`, error);
    }
};


/**
 * Handles webhook events from Stripe to update order status.
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    let event;

    // Securely verify the webhook signature.
    let whSec;
    try {
        whSec = functions.config().stripe.webhook_secret;
    } catch (error) {
        console.error("Could not access stripe.webhook_secret. Make sure it is set in Firebase config.");
        return res.status(500).send("Webhook secret is not configured on the server.");
    }

    if (!whSec) {
        console.error("Stripe webhook secret is not configured. Set it with `firebase functions:config:set stripe.webhook_secret=...`");
        return res.status(500).send("Webhook secret not configured.");
    }

    try {
        const signature = req.headers['stripe-signature'];
        event = stripe.webhooks.constructEvent(req.rawBody, signature, whSec);
    } catch (err) {
        console.error('Webhook signature verification failed.', err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            console.log(`PaymentIntent for ${paymentIntent.amount} was successful!`);
            await fulfillOrder(paymentIntent);
            break;
        case 'payment_intent.payment_failed':
            const paymentIntentFailed = event.data.object;
            console.log(`Payment failed: ${paymentIntentFailed.last_payment_error?.message}`);
            // TODO: Notify the user that the payment failed.
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.status(200).send();
});

const crypto = require('crypto');

// ... (existing code)

/**
 * Redirects the user to the AliExpress authorization page to initiate the OAuth 2.0 flow.
 */
exports.aliexpressAuthRedirect = functions.runWith({ secrets: ["ALIEXPRESS_APP_KEY"] }).https.onRequest((req, res) => {
    cors(req, res, () => {
        const { uid } = req.query;
        if (!uid) {
            res.status(400).send("User ID (uid) is a required query parameter.");
            return;
        }

        const APP_KEY = process.env.ALIEXPRESS_APP_KEY;
        if (!APP_KEY) {
            console.error("ALIEXPRESS_APP_KEY secret is not set.");
            res.status(500).send("Application is not configured correctly.");
            return;
        }

        const REDIRECT_URI = `https://europe-west3-desire-loja-final.cloudfunctions.net/aliexpressAuthCallback`;

        // Create a state object containing the UID and a random nonce for CSRF protection.
        const nonce = crypto.randomBytes(16).toString('hex');
        const state = { uid, nonce };

        // We'll store the nonce in Firestore to validate it in the callback.
        db.collection('aliexpress_auth_states').doc(uid).set({ nonce: nonce, createdAt: admin.firestore.FieldValue.serverTimestamp() });

        // Encode the state object as a Base64 string to pass in the URL.
        const encodedState = Buffer.from(JSON.stringify(state)).toString('base64');

        const authorizationUrl = `https://oauth.aliexpress.com/authorize?response_type=code&client_id=${APP_KEY}&redirect_uri=${REDIRECT_URI}&state=${encodedState}&view=web`;

        console.log(`Redirecting to AliExpress for authorization: ${authorizationUrl}`);
        res.redirect(authorizationUrl);
    });
});


/**
 * Handles the callback from AliExpress after the user authorizes the application.
 * Exchanges the authorization code for an access token and stores it.
 */
exports.aliexpressAuthCallback = functions.runWith({ secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"] }).https.onRequest((req, res) => {
    cors(req, res, async () => {
        const { code, state } = req.query;
        let decodedState;

        if (!code || !state) {
            return res.status(400).send("Error: Missing code or state from AliExpress callback.");
        }

        // 1. Decode the state and extract UID and nonce
        try {
            decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
            if (!decodedState.uid || !decodedState.nonce) {
                throw new Error("Invalid state format.");
            }
        } catch (error) {
            console.error("Invalid state parameter:", error);
            return res.status(400).send("Error: Invalid state parameter.");
        }

        // 2. Validate the nonce (CSRF protection)
        const stateRef = db.collection('aliexpress_auth_states').doc(decodedState.uid);
        const stateDoc = await stateRef.get();

        if (!stateDoc.exists || stateDoc.data().nonce !== decodedState.nonce) {
            console.error(`CSRF Warning: State nonce mismatch for user ${decodedState.uid}.`);
            return res.status(403).send("Error: Invalid state. CSRF detected.");
        }

        // State is validated, delete it to prevent reuse.
        await stateRef.delete();

        const APP_KEY = process.env.ALIEXPRESS_APP_KEY;
        const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET;

        if (!APP_KEY || !APP_SECRET) {
            console.error("ALIEXPRESS_APP_KEY or ALIEXPRESS_APP_SECRET secret is not set.");
            res.status(500).send("Application is not configured correctly.");
            return;
        }
        const TOKEN_URL = 'https://api.aliexpress.com/rest/auth/token/create';

        try {
            const response = await axios.post(TOKEN_URL, null, {
                params: {
                    client_id: APP_KEY,
                    client_secret: APP_SECRET,
                    code: code,
                    grant_type: 'authorization_code',
                    redirect_uri: `https://europe-west3-desire-loja-final.cloudfunctions.net/aliexpressAuthCallback`,
                }
            });

            const responseData = response.data;
            if (!responseData || !responseData.access_token) {
                 // Try to parse the error if the response is a string
                let errorBody = responseData;
                try {
                    if (typeof responseData === 'string') {
                         errorBody = JSON.parse(responseData);
                    }
                } catch (e) {
                     // ignore parsing error
                }
                const errorMessage = errorBody.error_description || "No access token in response";
                console.error("Failed to obtain access token from AliExpress:", errorMessage, "Full response:", errorBody);
                return res.status(500).send(`Error: Could not obtain access token. ${errorMessage}`);
            }


            const { access_token, refresh_token, expire_time, refresh_token_valid_time, user_id, user_nick } = responseData;

            // 3. Store tokens using the validated UID
            await db.collection('aliexpress_tokens').doc(decodedState.uid).set({
                accessToken: access_token,
                refreshToken: refresh_token,
                accessTokenExpiresAt: Date.now() + (expire_time * 1000),
                refreshTokenExpiresAt: Date.now() + (refresh_token_valid_time * 1000),
                aliExpressUserId: user_id,
                aliExpressUserNick: user_nick,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(`Successfully stored AliExpress tokens for user ${decodedState.uid}`);
            res.status(200).send("<h1>Authentication successful!</h1><p>You can now close this window.</p>");

        } catch (error) {
            console.error("Error exchanging authorization code for access token:", error.response ? error.response.data : error.message);
            res.status(500).send("An error occurred while communicating with AliExpress.");
        }
    });
});


/**
 * A callable function to import a product from AliExpress using its URL.
 */
exports.importAliExpressProduct = functions.runWith({ secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"] }).https.onCall(async (data, context) => {
    // 1. Authentication and Authorization Check
    // Ensure the user is authenticated and is an admin.
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) {
        throw new functions.https.HttpsError('permission-denied', 'You must be an admin to perform this action.');
    }

    const { productUrl } = data;
    if (!productUrl) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "productUrl" argument.');
    }

    // 2. Extract Product ID from URL
    let productId;
    try {
        const url = new URL(productUrl);
        productId = url.pathname.split('/')[2].replace('.html', '');
    } catch (error) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid AliExpress product URL.');
    }

    // 3. Retrieve Stored Tokens
    // The user calling this function is the admin, so we use their UID.
    const tokenRef = db.collection('aliexpress_tokens').doc(context.auth.uid);
    const tokenDoc = await tokenRef.get();

    if (!tokenDoc.exists) {
        throw new functions.https.HttpsError('failed-precondition', 'AliExpress account not connected. Please connect your account first.');
    }

    let { accessToken, refreshToken, accessTokenExpiresAt } = tokenDoc.data();

    // 4. Token Refresh Logic
    if (Date.now() >= accessTokenExpiresAt) {
        console.log('Access token expired, refreshing...');
        try {
            const APP_KEY = process.env.ALIEXPRESS_APP_KEY;
            const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET;
            const REFRESH_URL = 'https://api.aliexpress.com/rest/auth/token/refresh';

            if (!APP_KEY || !APP_SECRET) {
                throw new functions.https.HttpsError('internal', 'AliExpress API secrets are not configured on the server.');
            }

            const response = await axios.post(REFRESH_URL, null, {
                params: {
                    client_id: APP_KEY,
                    client_secret: APP_SECRET,
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token',
                }
            });

            if (response.data.access_token) {
                accessToken = response.data.access_token;
                refreshToken = response.data.refresh_token; // A new refresh token might be returned
                accessTokenExpiresAt = Date.now() + (response.data.expire_time * 1000);

                await tokenRef.update({
                    accessToken: accessToken,
                    refreshToken: refreshToken,
                    accessTokenExpiresAt: accessTokenExpiresAt,
                });
                console.log('Successfully refreshed access token.');
            } else {
                throw new Error('Failed to refresh token: ' + JSON.stringify(response.data));
            }
        } catch (error) {
            console.error('Error refreshing AliExpress access token:', error.response ? error.response.data : error.message);
            throw new functions.https.HttpsError('unknown', 'Could not refresh the AliExpress session. Please try reconnecting your account.');
        }
    }

    // 5. Make API Call to Get Product Details
    try {
        const API_BASE_URL = 'https://api.aliexpress.com/rest';
        const METHOD = 'aliexpress.ds.product.get';
        const APP_KEY = process.env.ALIEXPRESS_APP_KEY;
        const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET;

        if (!APP_KEY || !APP_SECRET) {
            throw new functions.https.HttpsError('internal', 'AliExpress API secrets are not configured on the server.');
        }

        const params = {
            app_key: APP_KEY,
            sign_method: 'sha256',
            timestamp: Date.now(),
            method: METHOD,
            product_id: productId,
            session: accessToken, // AliExpress API expects the token as 'session'
        };

        // Create the signature for the API call
        const sortedKeys = Object.keys(params).sort();
        const signString = sortedKeys.map(key => key + params[key]).join('');
        const sign = crypto.createHmac('sha256', APP_SECRET).update(signString).digest('hex').toUpperCase();

        const response = await axios.get(`${API_BASE_URL}`, {
            params: {
                ...params,
                sign: sign,
            }
        });

        // 6. Process and Return Product Data
        const result = response.data.aliexpress_ds_product_get_response?.result;
        if (!result) {
            console.error("Error fetching product from AliExpress:", response.data);
            throw new functions.https.HttpsError('not-found', 'Could not retrieve product details from AliExpress.');
        }

        // TODO: Map the result data to your own product schema.
        const productData = {
            name: result.ae_item_base_info_dto.subject,
            description: result.ae_item_base_info_dto.detail,
            // ... map other fields like images, price, variants, etc.
        };

        return { success: true, product: productData };

    } catch (error) {
        console.error('Error fetching AliExpress product:', error.response ? error.response.data : error.message);
        throw new functions.https.HttpsError('unknown', 'An error occurred while fetching the product data from AliExpress.');
    }
});

/**
 * Server-side rendering function for the application.
 */
exports.ssr = functions.https.onRequest(renderer.render);
