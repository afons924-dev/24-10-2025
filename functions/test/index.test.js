const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

// --- Mocks Setup ---
// Stub for Firestore document reference
const docStub = (data) => ({
    exists: data !== null,
    data: () => data,
    get: () => Promise.resolve(docStub(data)),
    ref: { path: `mock/${Math.random()}` }
});

// Stub for Firestore collection reference
const collectionStub = (data) => ({
    doc: sinon.stub().returns(docStub(data)),
    where: sinon.stub().returnsThis(),
    limit: sinon.stub().returnsThis(),
    get: () => Promise.resolve([docStub(data)]),
    add: sinon.stub().resolves(docStub({ id: 'new-mail-id' })),
});

// Mock for the cors module
const corsStub = sinon.stub().callsFake((req, res, callback) => callback());


describe('Cloud Functions: fulfillOrder', () => {
    let functions;
    let adminStub, dbStub, transactionStub, mailStub;

    beforeEach(() => {
        // Reset stubs for each test to ensure isolation
        mailStub = collectionStub({});
        transactionStub = {
            get: sinon.stub(),
            set: sinon.stub(),
            update: sinon.stub(),
            getAll: sinon.stub()
        };

        // Deeply stub Firestore
        dbStub = {
            collection: sinon.stub(),
            runTransaction: sinon.stub().callsFake(async (updateFunction) => {
                // Execute the transaction logic with the mocked transaction object
                await updateFunction(transactionStub);
            }),
        };
        dbStub.collection.withArgs('mail').returns(mailStub);


        adminStub = {
            initializeApp: sinon.stub(),
            firestore: () => dbStub,
            auth: () => ({
                getUserByEmail: sinon.stub(),
                setCustomUserClaims: sinon.stub(),
            }),
        };
        adminStub.firestore.FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP' };

        // Use proxyquire to load the functions file with our mocks
        functions = proxyquire('../index', {
            'firebase-admin': adminStub,
            'cors': () => corsStub,
        });
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should successfully fulfill an order, update stock, and send emails', async () => {
        // --- Test Data ---
        const paymentIntent = {
            id: 'pi_12345',
            amount: 2550, // €25.50
            metadata: { loyaltyPointsUsed: '50' }
        };

        const sessionData = {
            userId: 'user_abc',
            cart: [
                { id: 'prod_1', name: 'T-Shirt', quantity: 2, price: 10.00 },
                { id: 'prod_2', name: 'Mug', quantity: 1, price: 5.50 }
            ]
        };

        const userData = {
            email: 'customer@example.com',
            firstName: 'John',
            loyaltyPoints: 100,
            address: { street: '123 Main St', city: 'Anytown' }
        };

        const product1Data = { name: 'T-Shirt', stock: 10, sold: 5 };
        const product2Data = { name: 'Mug', stock: 20, sold: 2 };

        // --- Mock Firestore Interactions ---
        // Mock the Stripe session document
        const sessionDoc = docStub(sessionData);
        sessionDoc.delete = sinon.stub().resolves(); // Add delete stub for the finally block
        dbStub.collection.withArgs('stripe_sessions').returns({ doc: sinon.stub().withArgs(paymentIntent.id).returns(sessionDoc) });

        // Mock the user document for re-fetching after transaction
        const userDocRef = docStub(userData);
        dbStub.collection.withArgs('users').returns({ doc: sinon.stub().withArgs('user_abc').returns(userDocRef) });

        // Mock the order collection for the new order
        const orderCollection = { doc: sinon.stub().returns({ set: sinon.stub() }) };
        dbStub.collection.withArgs('orders').returns(orderCollection);


        // Mock interactions within the transaction
        transactionStub.get.withArgs(userDocRef).resolves(docStub(userData));
        const product1Ref = { id: 'prod_1' };
        const product2Ref = { id: 'prod_2' };
        dbStub.collection.withArgs('products').returns({
            doc: (id) => (id === 'prod_1' ? product1Ref : product2Ref)
        });
        transactionStub.getAll.resolves([docStub(product1Data), docStub(product2Data)]);

        // --- Execute the function ---
        await functions.fulfillOrder(paymentIntent);


        // --- Assertions ---
        // 1. Transaction created an order
        const expectedTotal = paymentIntent.amount / 100;
        const expectedPointsAwarded = Math.floor(expectedTotal);
        expect(transactionStub.set.calledOnce).to.be.true;
        const orderData = transactionStub.set.firstCall.args[1];
        expect(orderData.userId).to.equal('user_abc');
        expect(orderData.total).to.equal(expectedTotal);
        expect(orderData.items).to.deep.equal(sessionData.cart);
        expect(orderData.status).to.equal('Em processamento');


        // 2. Transaction updated stock correctly
        expect(transactionStub.update.callCount).to.equal(3); // 2 products + 1 user
        const prod1Update = transactionStub.update.getCall(0).args[1];
        const prod2Update = transactionStub.update.getCall(1).args[1];
        expect(prod1Update.stock).to.equal(8); // 10 - 2
        expect(prod1Update.sold).to.equal(7); // 5 + 2
        expect(prod2Update.stock).to.equal(19); // 20 - 1
        expect(prod2Update.sold).to.equal(3); // 2 + 1

        // 3. Transaction updated user points and cleared cart
        const userUpdate = transactionStub.update.getCall(2).args[1];
        const expectedNewPoints = userData.loyaltyPoints - paymentIntent.metadata.loyaltyPointsUsed + expectedPointsAwarded;
        expect(userUpdate.loyaltyPoints).to.equal(expectedNewPoints); // 100 - 50 + 25 = 75
        expect(userUpdate.cart).to.deep.equal([]);


        // 4. Confirmation emails were sent
        expect(mailStub.add.callCount).to.equal(2);
        const customerEmail = mailStub.add.firstCall.args[0];
        const adminEmail = mailStub.add.secondCall.args[0];
        expect(customerEmail.to).to.equal('customer@example.com');
        expect(customerEmail.message.subject).to.include('Confirmação da sua encomenda');
        expect(adminEmail.to).to.equal('geral@darkdesire.pt');
        expect(adminEmail.message.subject).to.include('Nova Venda!');

        // 5. Session document was deleted
        expect(sessionDoc.delete.calledOnce).to.be.true;
    });

    it('should fail fulfillment, send error emails, and not change data if stock is insufficient', async () => {
        // --- Test Data ---
        const paymentIntent = { id: 'pi_fail_67890', amount: 2000, metadata: {} };
        const sessionData = {
            userId: 'user_def',
            cart: [{ id: 'prod_low_stock', name: 'Limited Edition', quantity: 5 }]
        };
        const userData = { email: 'buyer@example.com', firstName: 'Jane' };
        const productData = { name: 'Limited Edition', stock: 2, sold: 10 }; // Only 2 in stock, user wants 5

        // --- Mock Firestore Interactions ---
        const sessionDoc = docStub(sessionData);
        sessionDoc.delete = sinon.stub().resolves();
        dbStub.collection.withArgs('stripe_sessions').returns({ doc: sinon.stub().withArgs(paymentIntent.id).returns(sessionDoc) });

        const userDocRef = docStub(userData);
        dbStub.collection.withArgs('users').returns({ doc: sinon.stub().withArgs('user_def').returns(userDocRef) });

        // <<< FIX: Mock the 'orders' collection to prevent TypeError >>>
        const orderCollection = { doc: sinon.stub().returns({ set: sinon.stub() }) };
        dbStub.collection.withArgs('orders').returns(orderCollection);

        transactionStub.get.withArgs(userDocRef).resolves(docStub(userData));
        const productRef = { id: 'prod_low_stock' };
        dbStub.collection.withArgs('products').returns({ doc: sinon.stub().returns(productRef) });
        transactionStub.getAll.resolves([docStub(productData)]);

        // --- Execute and Assert ---
        await functions.fulfillOrder(paymentIntent);

        // 1. Transaction should NOT have set any order or updated anything
        expect(transactionStub.set.called).to.be.false;
        expect(transactionStub.update.called).to.be.false;

        // 2. Error emails WERE sent
        expect(mailStub.add.callCount).to.equal(2);
        const customerEmail = mailStub.add.firstCall.args[0];
        const adminEmail = mailStub.add.secondCall.args[0];

        expect(customerEmail.to).to.equal('buyer@example.com');
        expect(customerEmail.message.subject).to.include('Problema com a sua encomenda');
        expect(customerEmail.message.html).to.include('encontrámos um erro ao processar a sua encomenda');

        expect(adminEmail.to).to.equal('geral@darkdesire.pt');
        expect(adminEmail.message.subject).to.include('URGENTE: Falha no processamento da encomenda');
        expect(adminEmail.message.html).to.include('Motivo do Erro');


        // 3. Session document was STILL deleted
        expect(sessionDoc.delete.calledOnce).to.be.true;
    });
});

const crypto = require('crypto');

describe('Cloud Functions: _importAliExpressProductLogic', () => {
    let aliexpressAuth, fetchStub, adminStub, dbStub, clock;
    const APP_KEY = 'test_app_key';
    const APP_SECRET = 'test_app_secret';
    const ACCESS_TOKEN = 'test_access_token';

    beforeEach(() => {
        // --- Mock Dependencies ---
        fetchStub = sinon.stub();

        const tokenData = {
            accessToken: ACCESS_TOKEN,
            expiresAt: Date.now() + 3600 * 1000 // Expires in 1 hour
        };
        const userProfile = { isAdmin: true };

        dbStub = {
            collection: sinon.stub().returns({
                doc: (docId) => {
                    if (docId === 'user_specific_id') {
                        return docStub(tokenData); // For aliexpress_tokens collection
                    }
                    return docStub(userProfile); // For users collection
                }
            })
        };

        adminStub = {
            initializeApp: sinon.stub(),
            firestore: () => dbStub,
        };

        aliexpressAuth = proxyquire('../src/aliexpressAuth', {
            'node-fetch': fetchStub,
            'firebase-admin': adminStub,
        });

        // --- Stub Environment & Time ---
        sinon.stub(process, 'env').value({
            ALIEXPRESS_APP_KEY: APP_KEY,
            ALIEXPRESS_APP_SECRET: APP_SECRET,
        });
        // Fix time for consistent signature generation
        clock = sinon.useFakeTimers(new Date("2023-10-27T10:00:00Z").getTime());
    });

    afterEach(() => {
        sinon.restore();
        clock.restore();
    });

    it('should construct a valid signed POST request to the AliExpress API', async () => {
        const data = { url: 'https://www.aliexpress.com/item/1234567890.html' };
        const context = { auth: { uid: 'admin_user_id' } };
        const mockApiResponse = { aliexpress_ds_product_get_response: { result: { ae_item_base_info_dto: { subject: 'Test' }, ae_item_sku_info_dtos: [], ae_multimedia_info_dto: { image_urls: '' } } } };

        fetchStub.resolves({ json: () => Promise.resolve(mockApiResponse) });

        await aliexpressAuth._importAliExpressProductLogic(data, context);

        // --- Assertions for Request Structure & Signature ---
        expect(fetchStub.calledOnce).to.be.true;
        const [requestUrl, requestOptions] = fetchStub.firstCall.args;

        // 1. Assert POST method and headers
        expect(requestOptions.method).to.equal('POST');
        expect(requestOptions.headers['Content-Type']).to.equal('application/x-www-form-urlencoded;charset=utf-8');

        // 2. Assert body contains business parameters
        expect(requestOptions.body).to.equal('product_id=1234567890');

        // 3. Manually calculate expected signature for verification
        const systemParams = {
            app_key: APP_KEY,
            access_token: ACCESS_TOKEN,
            sign_method: 'sha256',
            format: 'json',
            v: '2.0',
            timestamp: '2023-10-27 10:00:00',
            method: 'aliexpress.ds.product.get',
        };
        const businessParams = { product_id: '1234567890' };
        const allParams = { ...systemParams, ...businessParams };
        const sortedKeys = Object.keys(allParams).sort();
        let signString = '';
        sortedKeys.forEach(key => { signString += key + allParams[key]; });
        const expectedSign = crypto.createHmac('sha256', APP_SECRET).update(signString).digest('hex').toUpperCase();

        // 4. Assert URL contains system parameters and correct signature
        const url = new URL(requestUrl);
        expect(url.searchParams.get('sign')).to.equal(expectedSign);
        expect(url.searchParams.get('app_key')).to.equal(APP_KEY);
        expect(url.searchParams.get('timestamp')).to.equal('2023-10-27 10:00:00');
    });


    it('should throw a permission error if user is not an admin', async () => {
        // Override the default user profile mock for this specific test
        dbStub.collection.withArgs('users').returns({ doc: () => docStub({ isAdmin: false }) });

        const data = { url: 'https://www.aliexpress.com/item/1234567890.html' };
        const context = { auth: { uid: 'non_admin_user_id' } };

        await expect(aliexpressAuth._importAliExpressProductLogic(data, context)).to.be.rejectedWith('Must be an administrative user to call this function.');
        expect(fetchStub.notCalled).to.be.true;
    });

    it('should throw an HttpsError if the AliExpress API returns an error', async () => {
        const data = { url: 'https://www.aliexpress.com/item/1234567890.html' };
        const context = { auth: { uid: 'admin_user_id' } };
        const mockErrorResponse = { error_response: { code: 20010000, msg: 'API Error Message' } };

        fetchStub.resolves({ json: () => Promise.resolve(mockErrorResponse) });

        await expect(aliexpressAuth._importAliExpressProductLogic(data, context)).to.be.rejectedWith('AliExpress API Error: API Error Message');
    });

    it('should throw an error for an invalid URL format', async () => {
        const data = { url: 'https://www.invalid-url.com' };
        const context = { auth: { uid: 'admin_user_id' } };

        await expect(aliexpressAuth._importAliExpressProductLogic(data, context)).to.be.rejectedWith('Invalid AliExpress URL format.');
    });
});
