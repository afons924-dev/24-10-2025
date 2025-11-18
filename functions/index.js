
const { onRequest } = require("firebase-functions/v2/https");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const axios = require("axios");
const crypto = require('crypto');
const renderer = require("./renderer");
const Stripe = require("stripe");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();
renderer.init(db);

// Define allowed origins for CORS
const corsOptions = {
    origin: [
        "https://desire-loja-final.web.app",
        "https://darkdesire.pt",
        "http://localhost:5000",
        "http://127.0.0.1:5000"
    ],
    methods: ["POST", "GET"],
    allowedHeaders: ["Content-Type", "Authorization"],
};

// Initialize Stripe client on-demand within functions
let stripe;

/**
 * Creates a Stripe Payment Intent.
 */
exports.createStripePaymentIntent = onRequest({ secrets: ["STRIPE_SECRET_KEY"], cors: corsOptions }, async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    if (!stripe) {
        stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    }

    const { userId, cart } = req.body;

    if (!userId || !cart || !Array.isArray(cart) || cart.length === 0) {
        return res.status(400).send({ error: "Missing or invalid parameters: userId and cart are required." });
    }

    try {
        let amount = 0;
        for (const item of cart) {
            const productRef = db.collection("products").doc(item.id);
            const productDoc = await productRef.get();
            if (productDoc.exists) {
                amount += productDoc.data().price * item.quantity;
            }
        }
        const amountInCents = Math.round(amount * 100);

        if (amountInCents < 50) {
            return res.status(400).send({ error: `Amount is too small. Minimum charge is €0.50. Amount calculated: €${amount.toFixed(2)}` });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: "eur",
            payment_method_types: ['card'],
            metadata: { userId }
        });

        const sessionRef = db.collection('stripe_sessions').doc(paymentIntent.id);
        await sessionRef.set({
            userId,
            cart,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.status(200).send({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        logger.error("Stripe Payment Intent creation failed:", error);
        return res.status(500).send({ error: "Failed to create Stripe Payment Intent." });
    }
});

/**
 * Fulfills an order by creating it in Firestore and updating stock.
 */
const fulfillOrder = async (paymentIntent) => {
    const sessionRef = db.collection('stripe_sessions').doc(paymentIntent.id);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
        logger.error(`Could not find session for payment intent: ${paymentIntent.id}`);
        return;
    }

    const { userId, cart } = sessionDoc.data();
    if (!userId || !cart || !Array.isArray(cart) || cart.length === 0) {
        logger.error("Invalid session data from payment intent:", paymentIntent.id);
        return;
    }

    const orderRef = db.collection("orders").doc();
    const userRef = db.collection("users").doc(userId);

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new Error(`User ${userId} not found.`);
            const userProfile = userDoc.data();

            const productRefs = cart.map(item => db.collection("products").doc(item.id));
            const productDocs = await transaction.getAll(...productRefs);
            const fullCartItems = [];
            const productUpdates = [];

            for (let i = 0; i < cart.length; i++) {
                const productDoc = productDocs[i];
                if (!productDoc.exists) throw new Error(`Product with ID ${cart[i].id} not found.`);
                const productData = productDoc.data();
                const cartItem = cart[i];

                if (productData.stock < cartItem.quantity) throw new Error(`Stock insufficient for ${productData.name}.`);

                const newStock = productData.stock - cartItem.quantity;
                const newSoldCount = (productData.sold || 0) + cartItem.quantity;
                productUpdates.push({ ref: productDoc.ref, data: { stock: newStock, sold: newSoldCount } });

                fullCartItems.push({ ...cartItem, name: productData.name, price: productData.price, image: (productData.images && productData.images[0]) || productData.image || '' });
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

        await sessionRef.delete();
        logger.info(`Successfully fulfilled order for Payment Intent: ${paymentIntent.id}`);

    } catch (error) {
        logger.error(`Error fulfilling order for Payment Intent ${paymentIntent.id}:`, error);
    }
};

/**
 * Handles webhook events from Stripe.
 */
exports.stripeWebhook = onRequest({ secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] }, async (req, res) => {
    if (!stripe) {
        stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    }
    const whSec = process.env.STRIPE_WEBHOOK_SECRET;
    if (!whSec) {
        logger.error("Stripe webhook secret is not configured.");
        return res.status(500).send("Webhook secret not configured.");
    }

    try {
        const signature = req.headers['stripe-signature'];
        const event = stripe.webhooks.constructEvent(req.rawBody, signature, whSec);

        switch (event.type) {
            case 'payment_intent.succeeded':
                await fulfillOrder(event.data.object);
                break;
            case 'payment_intent.payment_failed':
                logger.warn(`Payment failed: ${event.data.object.last_payment_error?.message}`);
                break;
            default:
                logger.log(`Unhandled event type ${event.type}`);
        }
        return res.status(200).send();
    } catch (err) {
        logger.error('Webhook signature verification failed.', err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

/**
 * Redirects the user to the AliExpress authorization page.
 */
exports.aliexpressAuthRedirect = onRequest({ secrets: ["ALIEXPRESS_APP_KEY"], cors: corsOptions }, (req, res) => {
    const { uid } = req.query;
    if (!uid) {
        return res.status(400).send("User ID (uid) is a required query parameter.");
    }

    const APP_KEY = process.env.ALIEXPRESS_APP_KEY;
    if (!APP_KEY) {
        logger.error("ALIEXPRESS_APP_KEY secret is not set.");
        return res.status(500).send("Application is not configured correctly.");
    }

    const REDIRECT_URI = `https://europe-west3-desire-loja-final.cloudfunctions.net/aliexpressAuthCallback`;
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = { uid, nonce };

    db.collection('aliexpress_auth_states').doc(uid).set({ nonce, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    const encodedState = Buffer.from(JSON.stringify(state)).toString('base64');
    const authorizationUrl = `https://oauth.aliexpress.com/authorize?response_type=code&client_id=${APP_KEY}&redirect_uri=${REDIRECT_URI}&state=${encodedState}&view=web`;

    logger.info(`Redirecting to AliExpress for authorization: ${authorizationUrl}`);
    res.redirect(authorizationUrl);
});

/**
 * Handles the callback from AliExpress after authorization.
 */
exports.aliexpressAuthCallback = onRequest({ secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"], cors: corsOptions }, async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
        return res.status(400).send("Error: Missing code or state from AliExpress callback.");
    }

    try {
        const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        if (!decodedState.uid || !decodedState.nonce) throw new Error("Invalid state format.");

        const stateRef = db.collection('aliexpress_auth_states').doc(decodedState.uid);
        const stateDoc = await stateRef.get();

        if (!stateDoc.exists || stateDoc.data().nonce !== decodedState.nonce) {
            logger.error(`CSRF Warning: State nonce mismatch for user ${decodedState.uid}.`);
            return res.status(403).send("Error: Invalid state. CSRF detected.");
        }
        await stateRef.delete();

        const APP_KEY = process.env.ALIEXPRESS_APP_KEY;
        const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET;
        if (!APP_KEY || !APP_SECRET) {
            logger.error("ALIEXPRESS secrets are not set.");
            return res.status(500).send("Application is not configured correctly.");
        }

        const TOKEN_URL = 'https://api.aliexpress.com/rest/auth/token/create';
        const response = await axios.post(TOKEN_URL, null, {
            params: {
                client_id: APP_KEY, client_secret: APP_SECRET, code, grant_type: 'authorization_code',
                redirect_uri: `https://europe-west3-desire-loja-final.cloudfunctions.net/aliexpressAuthCallback`,
            }
        });

        const { access_token, refresh_token, expire_time, refresh_token_valid_time, user_id, user_nick } = response.data;
        if (!access_token) throw new Error('No access token in response from AliExpress.');

        await db.collection('aliexpress_tokens').doc(decodedState.uid).set({
            accessToken: access_token, refreshToken: refresh_token,
            accessTokenExpiresAt: Date.now() + (expire_time * 1000),
            refreshTokenExpiresAt: Date.now() + (refresh_token_valid_time * 1000),
            aliExpressUserId: user_id, aliExpressUserNick: user_nick,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        logger.info(`Successfully stored AliExpress tokens for user ${decodedState.uid}`);
        return res.status(200).send("<h1>Authentication successful!</h1><p>You can now close this window.</p>");

    } catch (error) {
        logger.error("Error during AliExpress auth callback:", error.response ? error.response.data : error.message);
        return res.status(500).send("An error occurred during authentication.");
    }
});

/**
 * Callable function to import a product from AliExpress.
 */
exports.importAliExpressProduct = onCall({ secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"] }, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');

    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) throw new HttpsError('permission-denied', 'You must be an admin.');

    const { productUrl } = request.data;
    if (!productUrl) throw new HttpsError('invalid-argument', 'Missing "productUrl" argument.');

    let productId;
    try {
        productId = new URL(productUrl).pathname.split('/')[2].replace('.html', '');
    } catch (error) {
        throw new HttpsError('invalid-argument', 'Invalid AliExpress product URL.');
    }

    const tokenRef = db.collection('aliexpress_tokens').doc(request.auth.uid);
    const tokenDoc = await tokenRef.get();
    if (!tokenDoc.exists) throw new HttpsError('failed-precondition', 'AliExpress account not connected.');

    let { accessToken, refreshToken, accessTokenExpiresAt } = tokenDoc.data();
    const APP_KEY = process.env.ALIEXPRESS_APP_KEY;
    const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET;
    if (!APP_KEY || !APP_SECRET) throw new HttpsError('internal', 'API secrets are not configured.');

    if (Date.now() >= accessTokenExpiresAt) {
        logger.info('Access token expired, refreshing...');
        try {
            const response = await axios.post('https://api.aliexpress.com/rest/auth/token/refresh', null, {
                params: { client_id: APP_KEY, client_secret: APP_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' }
            });

            if (response.data.access_token) {
                accessToken = response.data.access_token;
                await tokenRef.update({
                    accessToken: accessToken,
                    refreshToken: response.data.refresh_token,
                    accessTokenExpiresAt: Date.now() + (response.data.expire_time * 1000),
                });
                logger.info('Successfully refreshed access token.');
            } else {
                throw new Error('Failed to refresh token: ' + JSON.stringify(response.data));
            }
        } catch (error) {
            logger.error('Error refreshing AliExpress access token:', error.response ? error.response.data : error.message);
            throw new HttpsError('unknown', 'Could not refresh the AliExpress session.');
        }
    }

    try {
        const params = {
            app_key: APP_KEY, sign_method: 'sha256', timestamp: Date.now(),
            method: 'aliexpress.ds.product.get', product_id: productId, session: accessToken,
        };
        const signString = Object.keys(params).sort().map(key => key + params[key]).join('');
        params.sign = crypto.createHmac('sha256', APP_SECRET).update(signString).digest('hex').toUpperCase();

        const response = await axios.get('https://api.aliexpress.com/rest', { params });
        const result = response.data.aliexpress_ds_product_get_response?.result;
        if (!result) {
            logger.error("Error fetching product from AliExpress:", response.data);
            throw new HttpsError('not-found', 'Could not retrieve product details from AliExpress.');
        }

        const productData = {
            name: result.ae_item_base_info_dto.subject,
            description: result.ae_item_base_info_dto.detail,
        };
        return { success: true, product: productData };
    } catch (error) {
        logger.error('Error fetching AliExpress product:', error.response ? error.response.data : error.message);
        throw new HttpsError('unknown', 'An error occurred while fetching product data.');
    }
});

/**
 * Server-side rendering function.
 */
exports.ssr = onRequest(renderer.render);
