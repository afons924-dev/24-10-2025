const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// Função para importar produto do AliExpress
exports.importAliExpressProduct = functions.https.onCall(async (data, context) => {
  const productId = data.productId;
  
  if (!productId) {
    throw new functions.https.HttpsError('invalid-argument', 'O parâmetro productId é obrigatório.');
  }

  try {
    // Chama a função no aliexpressAuth.js para importar o produto
    const importResult = await importAliExpressProductFromAuth(productId);
    
    return { success: true, product: importResult.product };
  } catch (error) {
    console.error('Erro ao importar produto:', error);
    throw new functions.https.HttpsError('internal', 'Erro ao importar produto do AliExpress');
  }
});

// Função para importar produto diretamente usando o backend do AliExpress
async function importAliExpressProductFromAuth(productId) {
  // Simula a chamada para a função aliexpressAuth.js, que deve retornar os dados do produto
  const importResult = await admin.firestore().collection("aliexpress").doc("token").get();
  
  if (!importResult.exists) {
    throw new Error("Token AliExpress não encontrado");
  }

  return importResult;
}
