/**************************************************** 
 * aliexpressAuth.js — AliExpress OAuth + API dropshipping 
 ****************************************************/

const axios = require("axios");
const admin = require("firebase-admin");
require("dotenv").config();

const APP_KEY = process.env.ALIEXPRESS_APP_KEY || "521214";  // Sua App Key
const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET || "1L5kLkYSRsfsVT38wsZREVGOA0zDyVXY";  // Sua Secret Key

const REDIRECT_URI = "https://europe-west3-desire-loja-final.cloudfunctions.net/aliexpressAuthCallback";

/**
 * STEP 1 — Redirect para AliExpress OAuth
 * O usuário é redirecionado para a página de autorização do AliExpress.
 */
exports.aliexpressAuthRedirect = async (req, res) => {
  try {
    const state = "secure123"; // Estado aleatório para segurança
    const url =
      `https://oauth.aliexpress.com/oauth/authorize?app_key=${APP_KEY}` + 
      `&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` + 
      `&state=${state}`;
    return res.redirect(url);
  } catch (err) {
    console.error("Redirect error:", err);
    res.status(500).send("Erro ao redirecionar para AliExpress OAuth");
  }
};

/**
 * STEP 2 — Callback troca o 'code' pelo 'access_token' e 'refresh_token'
 * A função recebe o código de autorização e troca por tokens de acesso.
 */
exports.aliexpressAuthCallback = async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Code não recebido");

  try {
    const tokenURL = "https://openapi.aliexpress.com/v2/oauth2/token"; // endpoint atualizado
    const params = {
      grant_type: "authorization_code",
      client_id: APP_KEY,
      client_secret: APP_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    };

    const response = await axios.post(tokenURL, null, { params });
    const tokenData = response.data;

    // Guardar no Firestore
    await admin.firestore().collection("aliexpress").doc("token").set({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.send(`
      <h2>Autorização concluída!</h2>
      <p>Podes fechar esta página.</p>
      <pre>${JSON.stringify(tokenData, null, 2)}</pre>
    `);
  } catch (err) {
    console.error("Erro ao trocar code por token:", err.response?.data || err);
    res.status(500).send("Erro ao gerar access token");
  }
};

/**
 * STEP 3 — Função callable para importar produtos
 * Esta função importa o produto do AliExpress com base no productId.
 * Se o token estiver prestes a expirar, ele será renovado automaticamente.
 */
exports.importAliExpressProduct = async (data, context) => {
  const { productId } = data;
  if (!productId) {
    throw new Error("productId é obrigatório");
  }

  try {
    const tokenDoc = await admin.firestore().collection("aliexpress").doc("token").get();
    if (!tokenDoc.exists) throw new Error("Token AliExpress não encontrado");

    let { access_token, refresh_token, expires_in, updated_at } = tokenDoc.data();

    // Verifica se o token expira em menos de 24h
    const expiryDate = updated_at.toDate().getTime() + expires_in * 1000;
    if (Date.now() > expiryDate - 24 * 60 * 60 * 1000) {
      console.log("Token quase a expirar, renovando...");
      const refreshURL = "https://openapi.aliexpress.com/v2/oauth2/token";
      const refreshParams = {
        grant_type: "refresh_token",
        client_id: APP_KEY,
        client_secret: APP_SECRET,
        refresh_token
      };
      const refreshResponse = await axios.post(refreshURL, null, { params: refreshParams });
      access_token = refreshResponse.data.access_token;
      refresh_token = refreshResponse.data.refresh_token;
      expires_in = refreshResponse.data.expires_in;

      await admin.firestore().collection("aliexpress").doc("token").set({
        access_token,
        refresh_token,
        expires_in,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Chamada para a API do AliExpress para buscar os dados do produto
    const apiURL = "https://openapi.aliexpress.com/api";
    const response = await axios.get(apiURL, {
      params: {
        method: "aliexpress.ds.product.get",
        product_id: productId,
        app_key: APP_KEY,
        session: access_token
      }
    });

    const productData = response.data;

    // Criando o produto no seu banco de dados (Firestore, por exemplo)
    const productDocRef = await admin.firestore().collection("products").add({
      name: productData.productName,
      price: productData.productPrice,
      description: productData.productDescription,
      imageUrl: productData.productImageUrl,
      aliexpress_product_id: productId,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, productId: productDocRef.id, product: productData };
  } catch (err) {
    console.error("Erro a importar produto:", err.response?.data || err);
    throw new functions.https.HttpsError('internal', 'Erro ao importar produto', err);
  }
};
