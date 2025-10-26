const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const cheerio = require("cheerio");
const renderer = require("./renderer");

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
    "http://127.0.0.1:5000",
    "http://localhost:8000"
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

            const ADMIN_EMAIL = "YOUR_ADMIN_EMAIL"; // TODO: Replace with your actual admin email
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

/**
 * Scrapes product data from an AliExpress URL.
 * This is a callable function that requires the user to be authenticated.
 */
exports.scrapeAliExpress = functions.https.onCall(async (data, context) => {
    // Check for authentication
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const {
        url
    } = data;
    if (!url || !url.startsWith('https://www.aliexpress.com/')) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a valid AliExpress URL.');
    }

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const html = response.data;
        const $ = cheerio.load(html);

        // Extract the title
        const title = $('h1').text().trim();

        // Extract the price
        const priceText = $('.product-price-value').first().text().trim();
        const price = parseFloat(priceText.replace(/[^0-9,.-]+/g, "").replace(",", "."));


        // Extract the description from the meta tag
        const description = $('meta[property="og:description"]').attr('content') || 'No description found';

        // Extract image URLs from the page
        const images = [];
        $('.gallery_Gallery__picList__h87k2 img').each((i, el) => {
            const imageUrl = $(el).attr('src');
            if (imageUrl) {
                images.push(imageUrl.replace('_50x50.jpg', '_800x800.jpg'));
            }
        });


        // Return the scraped data
        return {
            title,
            price,
            description,
            images
        };
    } catch (error) {
        console.error('Error scraping AliExpress:', error);
        throw new functions.https.HttpsError('internal', 'Failed to scrape the AliExpress page.');
    }
});

/**
 * Handles Server-Side Rendering (SSR) for SEO and social sharing.
 * It uses the renderer module to generate HTML for specific routes.
 */
exports.ssr = functions.https.onRequest(async (req, res) => {
    return renderer.render(req, res);
});
