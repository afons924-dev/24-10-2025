const fs = require('fs');
const path = require('path');
const mustache = require('mustache');

let db;
let indexHtml;
let templates = {};

// This is the root template that holds the basic HTML structure.
const rootTemplatePath = path.join(__dirname, '..', 'index.html');
const templatesPath = path.join(__dirname, '..', 'templates');

function init(database) {
    db = database;
    if (!indexHtml) { // Only load if not already loaded
        try {
            indexHtml = fs.readFileSync(rootTemplatePath, 'utf8');
            console.log("Root index.html loaded successfully.");
            preloadTemplates();
        } catch (e) {
            console.error("CRITICAL: Could not read root index.html. SSR will fail.", e);
            indexHtml = "<html><body>Error loading page.</body></html>";
        }
    }
}

function preloadTemplates() {
    try {
        const templateFiles = fs.readdirSync(templatesPath);
        templateFiles.forEach(file => {
            if (file.endsWith('.html')) {
                const templateName = file.slice(0, -5);
                const filePath = path.join(templatesPath, file);
                templates[templateName] = fs.readFileSync(filePath, 'utf8');
            }
        });
        console.log(`Preloaded ${Object.keys(templates).length} templates.`);
    } catch (e) {
        console.error("Could not preload templates:", e);
    }
}

async function renderProductDetail(productId) {
    if (!db) return null;
    try {
        const doc = await db.collection('products').doc(productId).get();
        if (!doc.exists) {
            return null;
        }
        const product = doc.data();
        return {
            title: `${product.name} | Desire`,
            description: product.description.substring(0, 160),
            image: (product.images && product.images[0]) || product.image || 'https://example.com/default-image.jpg'
        };
    } catch (error) {
        console.error("Error fetching product for SSR:", error);
        return null;
    }
}


async function render(req, res) {
    const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
    const path = url.pathname;
    const productId = url.searchParams.get('id');

    let meta = {
        title: 'Desire - Liberte as Suas Fantasias',
        description: 'Explore uma coleção de luxo de brinquedos e acessórios para adultos, desenhados para o prazer e bem-estar. Compra segura e discreta na Desire.',
        image: 'https://firebasestorage.googleapis.com/v0/b/desire-loja-final.firebasestorage.app/o/og-image.jpg?alt=media&token=example' // Default OG image
    };

    if (path.startsWith('/product/')) {
        const staticProductId = path.split('/')[2];
        const productMeta = await renderProductDetail(staticProductId);
        if (productMeta) {
            meta = productMeta;
        }
    }

    const renderedHtml = mustache.render(indexHtml, {
        META_TITLE: meta.title,
        META_DESCRIPTION: meta.description,
        META_OG_IMAGE: meta.image
    });

    res.set('Cache-Control', 'public, max-age=600, s-maxage=1200');
    res.status(200).send(renderedHtml);
}

module.exports = {
    init,
    render
};
