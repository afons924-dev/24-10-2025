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

describe('Cloud Functions: _importAliExpressProductLogic', () => {
    let aliexpressAuth;
    let fetchStub;

    beforeEach(() => {
        fetchStub = sinon.stub();
        // Use proxyquire to load the module with our fetch mock FIRST
        aliexpressAuth = proxyquire('../src/aliexpressAuth', {
            'node-fetch': fetchStub,
        });

        // THEN stub environment variables
        sinon.stub(process, 'env').value({
            ALIEXPRESS_APP_KEY: 'test_app_key',
            ALIEXPRESS_APP_SECRET: 'test_app_secret',
        });
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should import and transform product data successfully for an admin user', async () => {
        // --- Test Data ---
        const data = { url: 'https://www.aliexpress.com/item/1234567890.html' };
        const context = { auth: { token: { isAdmin: true } } };
        const mockApiResponse = {
            aliexpress_ds_product_get_response: {
                result: {
                    ae_item_base_info_dto: {
                        subject: 'Test Product Name',
                        detail: 'Test Product Description'
                    },
                    ae_sku_dtos: [
                        { offer_sale_price: '99.99' }
                    ],
                    ae_multimedia_info_dto: {
                        image_urls: 'url1.jpg;url2.jpg'
                    }
                }
            }
        };

        fetchStub.resolves({
            json: () => Promise.resolve(mockApiResponse),
        });

        // --- Execute the function ---
        const result = await aliexpressAuth._importAliExpressProductLogic(data, context);

        // --- Assertions ---
        expect(fetchStub.calledOnce).to.be.true;
        const fetchUrl = fetchStub.firstCall.args[0];
        expect(fetchUrl).to.include('product_id=1234567890');

        expect(result).to.deep.equal({
            name: 'Test Product Name',
            description: 'Test Product Description',
            price: 99.99,
            images: ['url1.jpg', 'url2.jpg']
        });
    });

    it('should throw a permission error if user is not an admin', async () => {
        const data = { url: 'https://www.aliexpress.com/item/1234567890.html' };
        const context = { auth: { token: { isAdmin: false } } }; // Not an admin

        await expect(aliexpressAuth._importAliExpressProductLogic(data, context)).to.be.rejectedWith('Must be an administrative user to call this function.');
        expect(fetchStub.notCalled).to.be.true;
    });

    it('should throw an error if the AliExpress API returns an error', async () => {
        const data = { url: 'https://www.aliexpress.com/item/1234567890.html' };
        const context = { auth: { token: { isAdmin: true } } };
        const mockErrorResponse = {
            error_response: {
                code: 20010000,
                msg: 'API Error Message'
            }
        };

        fetchStub.resolves({
            json: () => Promise.resolve(mockErrorResponse),
        });

        await expect(aliexpressAuth._importAliExpressProductLogic(data, context)).to.be.rejectedWith('AliExpress API Error: API Error Message');
    });

    it('should throw an error for an invalid URL', async () => {
        const data = { url: 'https://www.invalid-url.com' };
        const context = { auth: { token: { isAdmin: true } } };

        await expect(aliexpressAuth._importAliExpressProductLogic(data, context)).to.be.rejectedWith('Invalid AliExpress URL format.');
    });
});
