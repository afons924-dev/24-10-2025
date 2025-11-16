const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const admin = require('firebase-admin');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;


// Initialize a mock Firebase app for testing
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        databaseURL: 'https://desire-loja-final.firebaseio.com'
    });
}


describe('Cloud Functions: _importAliExpressProductLogic', () => {
    let aliexpressAuth;
    let fetchStub;
    let adminStub, dbStub;

    beforeEach(() => {
        fetchStub = sinon.stub();

        dbStub = {
            collection: sinon.stub().returns({
                doc: sinon.stub().returns({
                    get: sinon.stub().resolves({
                        exists: true,
                        data: () => ({ accessToken: 'mock_access_token', refreshToken: 'mock_refresh_token', expiresAt: Date.now() + 3600000 })
                    }),
                    set: sinon.stub().resolves()
                })
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

        sinon.stub(process, 'env').value({
            ALIEXPRESS_APP_KEY: 'test_app_key',
            ALIEXPRESS_APP_SECRET: 'test_app_secret',
        });
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should import and transform product data successfully for an admin user', async () => {
        const data = { url: 'https://www.aliexpress.com/item/1234567890.html' };
        const context = { auth: { token: { isAdmin: true } } };
        const mockApiResponse = {
            aliexpress_ds_product_get_response: {
                result: {
                    ae_item_base_info_dto: {
                        subject: 'Test Product Name',
                        detail: 'Test Product Description'
                    },
                    ae_item_sku_info_dtos: [
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

        const result = await aliexpressAuth._importAliExpressProductLogic(data, context);

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
        const context = { auth: { token: { isAdmin: false } } };

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
