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
const stripeConfig = functions.config().stripe;

if (stripeConfig && stripeConfig.secret) {
    stripe = require("stripe")(stripeConfig.secret);
} else {
    console.error("CRITICAL: Stripe secret key is not configured in Firebase config (stripe.secret). Payment functions will fail.");
    // We don't initialize stripe here, so it fails loudly and clearly.
}

/**
 * Creates a Stripe Payment Intent.
 * This is called by the client-side to initialize the payment flow.
 * It now securely calculates the total on the server-side and uses a temporary
 * Firestore document to pass cart data, avoiding metadata limits.
 */
exports.createStripePaymentIntent = functions.region('europe-west3').https.onRequest((req, res) => {
    cors(req, res, async () => {
        console.log("createStripePaymentIntent: Function triggered.");

        // Add a guard clause to ensure Stripe was initialized.
        if (!stripe) {
            console.error("createStripePaymentIntent: Stripe is not initialized. Check your Firebase functions configuration for stripe.secret.");
            return res.status(500).send({ error: "Stripe is not configured on the server. The admin needs to set the secret key." });
        }

        const { userId, cart, loyaltyPoints } = req.body;
        console.log(`createStripePaymentIntent: Received request for userId: ${userId}`);

        if (!userId || !cart || !Array.isArray(cart) || cart.length === 0) {
            console.error("createStripePaymentIntent: Invalid parameters received.", { userId, cart });
            return res.status(400).send({ error: "Missing or invalid parameters: userId and cart are required." });
        }

        try {
            console.log("createStripePaymentIntent: Fetching user document...");
            const userRef = db.collection("users").doc(userId);
            const userDoc = await userRef.get();
            if (!userDoc.exists) {
                console.error(`createStripePaymentIntent: User not found for ID: ${userId}`);
                return res.status(404).send({ error: "User not found." });
            }
            const userProfile = userDoc.data();
            console.log("createStripePaymentIntent: User document fetched successfully.");

            // Calculate total amount on the server by fetching prices from Firestore
            let amount = 0;
            console.log("createStripePaymentIntent: Calculating total amount from cart items...");
            for (const item of cart) {
                const productRef = db.collection("products").doc(item.id);
                const productDoc = await productRef.get();
                if (productDoc.exists) {
                    const price = productDoc.data().price;
                    amount += price * item.quantity;
                    console.log(`createStripePaymentIntent: Item ${item.id} - Price: ${price}, Quantity: ${item.quantity}. Subtotal: ${amount}`);
                } else {
                    console.warn(`createStripePaymentIntent: Product with ID ${item.id} not found during amount calculation.`);
                }
            }
            console.log(`createStripePaymentIntent: Gross amount calculated: €${amount.toFixed(2)}`);

            // Apply loyalty points discount on the server
            const availablePoints = userProfile.loyaltyPoints || 0;
            const pointsToRedeem = loyaltyPoints || 0;

            if (pointsToRedeem > 0) {
                console.log(`createStripePaymentIntent: Applying ${pointsToRedeem} loyalty points (Available: ${availablePoints}).`);
                if (pointsToRedeem > availablePoints) {
                    console.error("createStripePaymentIntent: User tried to use more loyalty points than available.");
                    return res.status(400).send({ error: "Insufficient loyalty points." });
                }
                const discountAmount = pointsToRedeem / 100; // 100 points = 1€
                amount -= discountAmount;
                console.log(`createStripePaymentIntent: Discount of €${discountAmount.toFixed(2)} applied. New total: €${amount.toFixed(2)}`);
            }

            amount = Math.max(amount, 0); // Ensure amount is not negative
            const amountInCents = Math.round(amount * 100);
            console.log(`createStripePaymentIntent: Final amount in cents: ${amountInCents}`);

            // Ensure the amount is above Stripe's minimum if it's not free
            if (amountInCents > 0 && amountInCents < 50) { // €0.50 minimum
                console.error(`createStripePaymentIntent: Amount ${amountInCents} cents is below Stripe's minimum.`);
                return res.status(400).send({ error: `Amount is too small. Minimum charge is €0.50. Amount calculated: €${amount.toFixed(2)}` });
            }

            console.log("createStripePaymentIntent: Creating Stripe Payment Intent...");
            // Create the Payment Intent with the server-calculated amount
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amountInCents,
                currency: "eur",
                automatic_payment_methods: { enabled: true }, // Let Stripe manage payment methods
                metadata: {
                    userId,
                    loyaltyPointsUsed: pointsToRedeem,
                },
            });
            console.log(`createStripePaymentIntent: Payment Intent created successfully with ID: ${paymentIntent.id}`);

            // Rebuild a full cart object with validated data
            const validatedCart = [];
            for (const item of cart) {
                const productDoc = await db.collection("products").doc(item.id).get();
                if (productDoc.exists) {
                    const productData = productDoc.data();
                    validatedCart.push({
                        id: item.id,
                        quantity: item.quantity,
                        name: productData.name,
                        price: productData.price, // Use the validated server price
                        image: (productData.images && productData.images[0]) || productData.image || ''
                    });
                }
            }

            // Store the FULL, validated cart details in the temporary session document
            const sessionRef = db.collection('stripe_sessions').doc(paymentIntent.id);
            await sessionRef.set({
                userId,
                cart: validatedCart,
                loyaltyPointsUsed: pointsToRedeem,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log("createStripePaymentIntent: Temporary session document created in Firestore.");

            return res.status(200).send({
                clientSecret: paymentIntent.client_secret,
            });
        } catch (error) {
            // DETAILED ERROR LOGGING
            console.error("--- DETAILED STRIPE PAYMENT INTENT ERROR ---");
            console.error("Timestamp:", new Date().toISOString());
            console.error("User ID:", userId);
            console.error("Error Code:", error.code);
            console.error("Error Type:", error.type);
            console.error("Error Message:", error.message);
            console.error("Full Error Object:", JSON.stringify(error, null, 2));
            console.error("--- END OF DETAILED ERROR ---");
            return res.status(500).send({ error: "Failed to create Stripe Payment Intent. Check function logs for details." });
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
    const mailCollection = db.collection("mail");
    const ADMIN_EMAIL = "geral@darkdesire.pt"; // Centralized admin email

    try {
        // Run the core logic within a transaction
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new Error(`User ${userId} not found.`);
            const userProfile = userDoc.data();

            const productRefs = cart.map(item => db.collection("products").doc(item.id));
            const productDocs = await transaction.getAll(...productRefs);
            const productUpdates = [];

            for (let i = 0; i < cart.length; i++) {
                const productDoc = productDocs[i];
                if (!productDoc.exists) throw new Error(`Product with ID ${cart[i].id} not found.`);

                const productData = productDoc.data();
                const cartItem = cart[i];

                if (productData.stock < cartItem.quantity) {
                    throw new Error(`Stock insufficient for ${productData.name} (ID: ${cartItem.id}). Requested: ${cartItem.quantity}, Available: ${productData.stock}`);
                }

                const newStock = productData.stock - cartItem.quantity;
                const newSoldCount = (productData.sold || 0) + cartItem.quantity;
                productUpdates.push({ ref: productDoc.ref, data: { stock: newStock, sold: newSoldCount } });
            }

            const total = paymentIntent.amount / 100;
            const pointsToAward = Math.floor(total);
            const orderData = {
                userId: userId,
                items: cart, // The cart from the session is now complete
                total: total,
                paymentIntentId: paymentIntent.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                shippingAddress: userProfile.address, status: 'Em processamento'
            };
            transaction.set(orderRef, orderData);

            productUpdates.forEach(update => transaction.update(update.ref, update.data));

            const pointsUsed = parseInt(paymentIntent.metadata.loyaltyPointsUsed) || 0;
            const currentPoints = userProfile.loyaltyPoints || 0;
            const newPoints = currentPoints - pointsUsed + pointsToAward;
            transaction.update(userRef, { loyaltyPoints: newPoints, cart: [] });
        });

        // If transaction is successful, send confirmation emails
        const userDoc = await userRef.get(); // Re-fetch user doc to get latest data
        if (userDoc.exists) {
            const userProfile = userDoc.data();
            const total = paymentIntent.amount / 100;

            await mailCollection.add({
                to: userProfile.email,
                message: {
                    subject: `Confirmação da sua encomenda #${orderRef.id}`,
                    html: `<h1>Obrigado pela sua encomenda!</h1><p>Olá ${userProfile.firstName || ''},</p><p>A sua encomenda com o ID #${orderRef.id} foi recebida e está a ser processada.</p><p>Total: €${total.toFixed(2)}</p><p>Obrigado por comprar na Desire!</p>`,
                },
            });

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
        console.error(`CRITICAL: Error fulfilling order for Payment Intent ${paymentIntent.id}:`, error);

        // Send notification emails on failure
        const userDoc = await userRef.get();
        if (userDoc.exists) {
            const userProfile = userDoc.data();
            await mailCollection.add({
                to: userProfile.email,
                message: {
                    subject: `Ação necessária: Problema com a sua encomenda`,
                    html: `<h1>Problema no Processamento da Encomenda</h1><p>Olá ${userProfile.firstName || ''},</p><p>Obrigado pela sua compra. O seu pagamento foi bem-sucedido, mas encontrámos um erro ao processar a sua encomenda (ex: produto fora de stock).</p><p><strong>Não se preocupe, a nossa equipa já foi notificada e irá resolver a situação manualmente.</strong> Entraremos em contacto em breve para confirmar os detalhes.</p><p>ID do Pagamento para referência: ${paymentIntent.id}</p><p>Pedimos desculpa pelo inconveniente.</p>`,
                },
            });
        }

        await mailCollection.add({
            to: ADMIN_EMAIL,
            message: {
                subject: `URGENTE: Falha no processamento da encomenda ${paymentIntent.id}`,
                html: `<h1>Falha Crítica no Processamento da Encomenda</h1><p>O pagamento para o Payment Intent <strong>${paymentIntent.id}</strong> foi bem-sucedido, mas a transação para criar a encomenda falhou.</p><p><strong>Ação manual necessária.</strong></p><p><strong>Motivo do Erro:</strong> ${error.message}</p><p><strong>User ID:</strong> ${userId}</p><p>Verifique o stock e crie a encomenda manualmente. O carrinho do cliente NÃO foi limpo.</p>`,
            },
        });

    } finally {
        // ALWAYS delete the temporary session document to prevent reprocessing
        await sessionRef.delete();
        console.log(`Cleaned up session document for Payment Intent: ${paymentIntent.id}`);
    }
};


/**
 * Handles webhook events from Stripe to update order status.
 */
exports.stripeWebhook = functions.region('europe-west3').https.onRequest(async (req, res) => {
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
exports.scrapeAliExpress = functions.region('europe-west3').https.onCall(async (data, context) => {
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

        let name, price, description, images = [];

        // New Strategy: Find the script tag containing the product data JSON
        let productData = null;
        $('script').each((i, el) => {
            const scriptContent = $(el).html();
            if (scriptContent && scriptContent.includes('window.runParams')) {
                const jsonStringMatch = scriptContent.match(/window\.runParams = ({.*});/);
                if (jsonStringMatch && jsonStringMatch[1]) {
                    try {
                        productData = JSON.parse(jsonStringMatch[1]);
                        return false; // Exit the loop once data is found
                    } catch (e) {
                        console.warn("Failed to parse AliExpress JSON data from window.runParams.", e.message);
                    }
                }
            }
        });

        if (productData && productData.data) {
            const data = productData.data;
            name = data.titleModule?.subject || '';
            description = data.descriptionModule?.descriptionUrl || 'No description found'; // This might be a URL, need to fetch it or find direct description
            price = parseFloat(data.priceModule?.formatedActivityPrice?.replace(/[^0-9,.-]+/g, "").replace(",", ".") || 0);
            images = data.imageModule?.imagePathList || [];
        }

        // Fallback Strategy: If JSON parsing fails or data is not found, use cheerio selectors
        if (!name) {
            name = $('h1').text().trim();
        }
        if (!price) {
            const priceText = $('.product-price-value').first().text().trim();
            price = parseFloat(priceText.replace(/[^0-9,.-]+/g, "").replace(",", "."));
        }
        if (!description || description.startsWith('http')) {
             description = $('meta[property="og:description"]').attr('content') || 'No description found';
        }
        if (images.length === 0) {
            $('img[src*="aliexpress.com/kf/"]').each((i, el) => {
                const imageUrl = $(el).attr('src');
                if (imageUrl) {
                    const highResUrl = imageUrl.split('.jpg_')[0] + '.jpg';
                    if (!images.includes(highResUrl)) {
                        images.push(highResUrl);
                    }
                }
            });
        }

        // Return the scraped data, ensuring name consistency
        return {
            name: name,
            price: price || 0,
            description: description,
            images: images
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
exports.ssr = functions.region('europe-west3').https.onRequest(async (req, res) => {
    return renderer.render(req, res);
});

/**
 * Sets a custom user claim `isAdmin` to true for a given user email.
 * This is an administrative function and should be protected.
 * Only callable by an already authenticated admin.
 */
exports.setAdminClaim = functions.region('europe-west3').https.onCall(async (data, context) => {
    // Check if the caller is an admin.
    // Note: The first admin must be set manually via Firebase console or gcloud CLI.
    if (context.auth.token.isAdmin !== true) {
        throw new functions.https.HttpsError('permission-denied', 'Only admins can set other users as admins.');
    }

    const { email } = data;
    if (!email) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with an "email" argument.');
    }

    try {
        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().setCustomUserClaims(user.uid, { isAdmin: true });

        // Update the user document in Firestore as well for consistency
        const userRef = db.collection('users').doc(user.uid);
        await userRef.set({ isAdmin: true }, { merge: true });

        return { message: `Success! ${email} has been made an admin.` };
    } catch (error) {
        console.error("Error setting admin claim:", error);
        throw new functions.https.HttpsError('internal', 'An internal error occurred while trying to set the admin claim.');
    }
});
