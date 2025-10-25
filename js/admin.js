import { collection, query, where, getDocs, addDoc, updateDoc, doc, orderBy, limit, serverTimestamp, getDoc } from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-functions.js';

let auth, db, functions;

// Global variables
window.db = db;
window.auth = auth;
window.currentUser = null;

// State management
const appState = {
    orders: [],
    products: [],
    stats: {
        pendingOrders: 0,
        totalOrders: 0,
        dropshipProducts: 0,
        todayRevenue: 0
    },
    loading: false
};

// Initialize Admin Panel
async function initializeAdmin() {
    try {
        showLoading(true);
        await Promise.all([
            loadStats(),
            loadOrders(),
            loadDropshipProducts()
        ]);
        showAlert('success', '✅ Painel admin carregado com sucesso!');
    } catch (error) {
        console.error('Error initializing admin:', error);
        showAlert('error', '❌ Erro ao carregar dados do admin.');
    } finally {
        showLoading(false);
    }
}

// Load Statistics
async function loadStats() {
    try {
        // Get all orders
        const ordersRef = collection(db, 'orders');
        const ordersSnapshot = await getDocs(ordersRef);

        let pendingCount = 0;
        let todayRevenue = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        ordersSnapshot.forEach(doc => {
            const order = doc.data();
            const orderDate = order.createdAt?.toDate() || new Date();

            // Count pending orders
            if (order.status === 'Em processamento' || order.status === 'pending') {
                pendingCount++;
            }

            // Calculate today's revenue
            if (orderDate >= today) {
                todayRevenue += order.total || 0;
            }
        });

        // Get dropship products count
        const productsRef = collection(db, 'products');
        const dropshipQuery = query(productsRef, where('isDropship', '==', true));
        const dropshipSnapshot = await getDocs(dropshipQuery);

        // Update UI
        document.getElementById('pendingOrdersCount').textContent = pendingCount;
        document.getElementById('totalOrdersCount').textContent = ordersSnapshot.size;
        document.getElementById('dropshipProductsCount').textContent = dropshipSnapshot.size;
        document.getElementById('todayRevenue').textContent = todayRevenue.toFixed(2);

        // Update settings info
        document.getElementById('totalProducts').textContent = dropshipSnapshot.size;
        document.getElementById('totalOrdersInfo').textContent = ordersSnapshot.size;

        // Store in state
        appState.stats = {
            pendingOrders: pendingCount,
            totalOrders: ordersSnapshot.size,
            dropshipProducts: dropshipSnapshot.size,
            todayRevenue: todayRevenue
        };

    } catch (error) {
        console.error('Error loading stats:', error);
        showAlert('error', '❌ Erro ao carregar estatísticas.');
    }
}

// Load Orders
async function loadOrders(forceRefresh = false) {
    if (appState.loading && !forceRefresh) return;

    const container = document.getElementById('ordersList');
    const recentContainer = document.getElementById('recentOrdersList');

    try {
        if (forceRefresh) showLoading(true);

        const ordersRef = collection(db, 'orders');
        const ordersQuery = query(ordersRef, orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(ordersQuery);

        if (snapshot.empty) {
            const emptyState = `
                <div class="empty-state">
                    <div class="empty-state-icon">📦</div>
                    <div class="empty-state-title">Nenhuma encomenda ainda</div>
                    <p>As encomendas aparecerão aqui quando os clientes fizerem compras.</p>
                </div>
            `;
            container.innerHTML = emptyState;
            recentContainer.innerHTML = emptyState;
            return;
        }

        let allOrdersHtml = '';
        let recentOrdersHtml = '';
        let recentCount = 0;
        const orders = [];

        snapshot.forEach(doc => {
            const order = doc.data();
            const orderHtml = renderOrderCard(doc.id, order);
            orders.push({ id: doc.id, ...order });

            allOrdersHtml += orderHtml;

            // Add to recent orders (max 5)
            if (recentCount < 5) {
                recentOrdersHtml += orderHtml;
                recentCount++;
            }
        });

        container.innerHTML = allOrdersHtml;
        recentContainer.innerHTML = recentOrdersHtml;
        appState.orders = orders;

    } catch (error) {
        console.error('Error loading orders:', error);
        const errorMsg = '<div class="alert alert-error">❌ Erro ao carregar encomendas</div>';
        container.innerHTML = errorMsg;
        recentContainer.innerHTML = errorMsg;
    } finally {
        if (forceRefresh) showLoading(false);
    }
}

// Load Dropship Products
async function loadDropshipProducts(forceRefresh = false) {
    if (appState.loading && !forceRefresh) return;

    const container = document.getElementById('productsList');

    try {
        if (forceRefresh) showLoading(true);

        const productsRef = collection(db, 'products');
        const dropshipQuery = query(productsRef, where('isDropship', '==', true), orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(dropshipQuery);

        if (snapshot.empty) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📦</div>
                    <div class="empty-state-title">Nenhum produto dropship</div>
                    <p>Adicione produtos usando o formulário acima.</p>
                </div>
            `;
            return;
        }

        let html = '<div class="product-grid">';
        const products = [];

        snapshot.forEach(doc => {
            const product = doc.data();
            products.push({ id: doc.id, ...product });
            html += renderProductCard(doc.id, product);
        });

        html += '</div>';
        container.innerHTML = html;
        appState.products = products;

    } catch (error) {
        console.error('Error loading products:', error);
        container.innerHTML = '<div class="alert alert-error">❌ Erro ao carregar produtos</div>';
    } finally {
        if (forceRefresh) showLoading(false);
    }
}

// Render Order Card
function renderOrderCard(orderId, order) {
    const date = order.createdAt?.toDate?.() || new Date();
    const shortId = orderId.substring(0, 8).toUpperCase();

    let statusClass = 'badge-pending';
    if (order.status === 'Enviada' || order.status === 'shipped') statusClass = 'badge-shipped';
    else if (order.status === 'A aguardar envio') statusClass = 'badge-processing';

    let itemsHtml = '';
    let hasDropshipItems = false;

    if (order.items && order.items.length > 0) {
        order.items.forEach(item => {
            if (item.isDropship) hasDropshipItems = true;

            itemsHtml += `
                <div class="order-item">
                    <div class="item-info">
                        <div class="item-name">${item.name || 'Produto'}</div>
                        <div class="item-details">
                            Qtd: ${item.quantity || 1} × €${(item.price || 0).toFixed(2)}
                            ${item.isDropship ? ' • <span style="color: var(--color-warning);">Dropship</span>' : ''}
                        </div>
                    </div>
                    <div class="item-price">€${((item.price || 0) * (item.quantity || 1)).toFixed(2)}</div>
                </div>
            `;
        });
    }

    // Only show orders with dropship items or if no items data
    if (!hasDropshipItems && order.items && order.items.length > 0) {
        return ''; // Skip non-dropship orders
    }

    return `
        <div class="order-card">
            <div class="order-header">
                <div class="order-info">
                    <h3>#${shortId}</h3>
                    <div class="order-meta">
                        <span>📅 ${date.toLocaleDateString('pt-PT')}</span>
                        <span>💰 €${(order.total || 0).toFixed(2)}</span>
                        ${order.customerEmail ? `<span>👤 ${order.customerEmail}</span>` : ''}
                    </div>
                </div>
                <span class="order-badge ${statusClass}">${order.status || 'Pendente'}</span>
            </div>

            ${itemsHtml ? `<div class="order-items">${itemsHtml}</div>` : ''}

            ${order.shippingAddress ? `
                <div class="customer-info">
                    <p><strong>Cliente:</strong> ${order.shippingAddress.name || 'N/A'}</p>
                    <p><strong>Email:</strong> ${order.shippingAddress.email || order.customerEmail || 'N/A'}</p>
                    <p><strong>Morada:</strong> ${formatAddress(order.shippingAddress)}</p>
                    ${order.shippingAddress.phone ? `<p><strong>Telefone:</strong> ${order.shippingAddress.phone}</p>` : ''}
                </div>
            ` : ''}

            ${order.trackingNumber ? `
                <div class="alert alert-success">
                    📦 <strong>Tracking:</strong> ${order.trackingNumber}
                    ${order.trackingCarrier ? `(${order.trackingCarrier})` : ''}
                </div>
            ` : ''}

            <div class="order-actions">
                <select class="form-select btn-sm" onchange="updateOrderStatus('${orderId}', this.value)" style="width: auto;">
                    <option value="Pendente" ${order.status === 'Pendente' ? 'selected' : ''}>Pendente</option>
                    <option value="Em processamento" ${order.status === 'Em processamento' ? 'selected' : ''}>Em processamento</option>
                    <option value="Enviada" ${order.status === 'Enviada' ? 'selected' : ''}>Enviada</option>
                    <option value="Entregue" ${order.status === 'Entregue' ? 'selected' : ''}>Entregue</option>
                    <option value="Cancelado" ${order.status === 'Cancelado' ? 'selected' : ''}>Cancelado</option>
                </select>
                ${!order.trackingNumber ? `
                    <button class="btn btn-success btn-sm" onclick="openTrackingModal('${orderId}')">
                        📦 Adicionar Tracking
                    </button>
                ` : ''}
                <button class="btn btn-outline btn-sm" onclick="copyOrderInfo('${orderId}')">
                    📋 Copiar Info
                </button>
            </div>
        </div>
    `;
}

// Render Product Card
function renderProductCard(productId, product) {
    const margin = (product.sellingPrice || product.price || 0) - (product.aliexpressPrice || product.cost || 0);
    const marginPercent = (product.cost || product.aliexpressPrice) > 0 ?
        ((margin / (product.cost || product.aliexpressPrice)) * 100).toFixed(0) : 0;

    return `
        <div class="product-card">
            ${product.image ? `<img src="${product.image}" alt="${product.name}" style="width: 100%; height: 200px; object-fit: cover; border-radius: 8px; margin-bottom: 1rem;">` : ''}
            <h4>${product.name}</h4>
            <div class="product-category">${product.category || 'Sem categoria'}</div>

            <div class="product-pricing">
                <span>Custo:</span>
                <strong>€${(product.cost || product.aliexpressPrice || 0).toFixed(2)}</strong>
            </div>
            <div class="product-pricing">
                <span>Venda:</span>
                <strong style="color: var(--color-success);">€${(product.price || product.sellingPrice || 0).toFixed(2)}</strong>
            </div>
            <div class="product-margin">
                <span>Margem:</span>
                <span>€${margin.toFixed(2)} (${marginPercent}%)</span>
            </div>

            <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                ${product.aliexpressUrl ? `
                    <a href="${product.aliexpressUrl}" target="_blank" class="btn btn-outline btn-sm" style="flex: 1;">
                        🔗 AliExpress
                    </a>
                ` : ''}
                <button class="btn btn-warning btn-sm" onclick="editProduct('${productId}')" style="flex: 1;">
                    ✏️ Editar
                </button>
            </div>
        </div>
    `;
}

// Helper Functions
function formatAddress(addr) {
    if (!addr) return 'N/A';
    const parts = [
        addr.street || addr.address,
        addr.city,
        addr.postalCode,
        addr.country
    ].filter(part => part && part.trim());
    return parts.join(', ') || 'N/A';
}

// Event Handlers
window.logout = async () => {
    try {
        await auth.signOut();
        window.location.href = '/';
    } catch (error) {
        console.error('Error signing out:', error);
        showAlert('error', '❌ Erro ao fazer logout');
    }
};

// Modal Functions
window.openTrackingModal = (orderId) => {
    document.getElementById('trackingOrderId').value = orderId;
    document.getElementById('trackingModal').classList.add('active');
    document.getElementById('trackingNumber').focus();
};

window.closeTrackingModal = () => {
    document.getElementById('trackingModal').classList.remove('active');
    document.getElementById('trackingForm').reset();
};

// Update Order Status
window.updateOrderStatus = async (orderId, newStatus) => {
    try {
        showLoading(true);
        const orderRef = doc(db, 'orders', orderId);
        await updateDoc(orderRef, {
            status: newStatus,
            updatedAt: serverTimestamp()
        });

        showAlert('success', '✅ Status da encomenda atualizado!');
        await loadOrders(true);
        await loadStats();

    } catch (error) {
        console.error('Error updating order:', error);
        showAlert('error', '❌ Erro ao atualizar encomenda');
    } finally {
        showLoading(false);
    }
};

// Copy Order Info
window.copyOrderInfo = (orderId) => {
    const order = appState.orders.find(o => o.id === orderId);
    if (!order) return;

    const info = `
Encomenda #${orderId.substring(0, 8).toUpperCase()}
Total: €${(order.total || 0).toFixed(2)}
Status: ${order.status || 'Pendente'}
Data: ${(order.createdAt?.toDate?.() || new Date()).toLocaleDateString('pt-PT')}
${order.shippingAddress ? `Cliente: ${order.shippingAddress.name}\nEmail: ${order.shippingAddress.email}` : ''}
    `;

    navigator.clipboard.writeText(info.trim()).then(() => {
        showAlert('success', '📋 Informação copiada!');
    }).catch(() => {
        showAlert('error', '❌ Erro ao copiar');
    });
};

// Product Functions
window.importProduct = async () => {
    const url = document.getElementById('aliUrl').value;
    if (!url || !url.includes('aliexpress.com')) {
        showAlert('error', '❌ Por favor, insira um URL válido do AliExpress.', 'importAlert');
        return;
    }

    showLoading(true);
    showAlert('info', '🔎 A extrair dados do produto... Isto pode demorar um pouco.', 'importAlert');

    try {
        const importFunction = httpsCallable(functions, 'importProductFromAliExpress');
        const result = await importFunction({ url });
        const productData = result.data;

        // Preencher o formulário com os dados extraídos
        document.getElementById('productName').value = productData.name || '';
        document.getElementById('productCost').value = productData.price || '';
        document.getElementById('productImage').value = productData.image || '';
        document.getElementById('aliexpressUrl').value = productData.aliexpressUrl || '';

        // Focar no formulário de produto
        showTab('products');
        document.getElementById('productName').focus();

        showAlert('success', '✅ Dados do produto importados! Verifique e guarde.', 'productAlert');

    } catch (error) {
        console.error("Error calling import function:", error);
        showAlert('error', `❌ ${error.message}`, 'importAlert');
    } finally {
        showLoading(false);
    }
};

window.editProduct = (productId) => {
    const product = appState.products.find(p => p.id === productId);
    if (!product) return;

    // Fill form with product data
    document.getElementById('productName').value = product.name || '';
    document.getElementById('productCategory').value = product.category || '';
    document.getElementById('productDescription').value = product.description || '';
    document.getElementById('productCost').value = product.cost || product.aliexpressPrice || '';
    document.getElementById('productPrice').value = product.price || product.sellingPrice || '';
    document.getElementById('productImage').value = product.image || '';
    document.getElementById('aliexpressUrl').value = product.aliexpressUrl || '';

    // Calculate margin
    calculateMargin();

    // Scroll to form
    document.querySelector('#products-tab .card').scrollIntoView({ behavior: 'smooth' });
    showAlert('info', '📝 Produto carregado para edição. Modifique e guarde.');
};

// Form Handlers
document.getElementById('productForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const productData = {
        name: document.getElementById('productName').value.trim(),
        category: document.getElementById('productCategory').value,
        description: document.getElementById('productDescription').value.trim(),
        cost: parseFloat(document.getElementById('productCost').value) || 0,
        price: parseFloat(document.getElementById('productPrice').value) || 0,
        image: document.getElementById('productImage').value.trim(),
        aliexpressUrl: document.getElementById('aliexpressUrl').value.trim(),
        isDropship: true,
        stock: 999,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };

    // Validation
    if (!productData.name) {
        showAlert('error', '❌ Nome do produto é obrigatório', 'productAlert');
        return;
    }

    if (!productData.category) {
        showAlert('error', '❌ Categoria é obrigatória', 'productAlert');
        return;
    }

    if (productData.cost <= 0 || productData.price <= 0) {
        showAlert('error', '❌ Preços devem ser maiores que zero', 'productAlert');
        return;
    }

    if (productData.price <= productData.cost) {
        showAlert('error', '❌ Preço de venda deve ser maior que custo', 'productAlert');
        return;
    }

    try {
        showLoading(true);

        const productsRef = collection(db, 'products');
        await addDoc(productsRef, productData);

        showAlert('success', '✅ Produto adicionado com sucesso!', 'productAlert');
        document.getElementById('productForm').reset();
        document.getElementById('marginDisplay').value = '';

        await Promise.all([
            loadDropshipProducts(true),
            loadStats()
        ]);

    } catch (error) {
        console.error('Error adding product:', error);
        showAlert('error', '❌ Erro ao adicionar produto', 'productAlert');
    } finally {
        showLoading(false);
    }
});

document.getElementById('trackingForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const orderId = document.getElementById('trackingOrderId').value;
    const trackingNumber = document.getElementById('trackingNumber').value.trim();
    const trackingCarrier = document.getElementById('trackingCarrier').value;

    if (!trackingNumber) {
        showAlert('error', '❌ Número de tracking é obrigatório');
        return;
    }

    try {
        showLoading(true);

        const orderRef = doc(db, 'orders', orderId);
        await updateDoc(orderRef, {
            trackingNumber,
            trackingCarrier,
            status: 'Enviada',
            shippedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        showAlert('success', '✅ Tracking adicionado com sucesso!');
        closeTrackingModal();

        await Promise.all([
            loadOrders(true),
            loadStats()
        ]);

    } catch (error) {
        console.error('Error adding tracking:', error);
        showAlert('error', '❌ Erro ao adicionar tracking');
    } finally {
        showLoading(false);
    }
});

// Calculate margin when prices change
document.getElementById('productCost').addEventListener('input', calculateMargin);
document.getElementById('productPrice').addEventListener('input', calculateMargin);

function calculateMargin() {
    const cost = parseFloat(document.getElementById('productCost').value) || 0;
    const price = parseFloat(document.getElementById('productPrice').value) || 0;
    const margin = price - cost;
    const marginPercent = cost > 0 ? ((margin / cost) * 100).toFixed(0) : 0;

    document.getElementById('marginDisplay').value = `€${margin.toFixed(2)} (${marginPercent}%)`;
}

// Settings
window.saveSettings = () => {
    const settings = {
        notificationEmail: document.getElementById('notificationEmail').value,
        defaultMargin: document.getElementById('defaultMargin').value,
        autoOrderEmail: document.getElementById('autoOrderEmail').checked
    };

    // Save to localStorage for now (you can implement Firebase storage)
    localStorage.setItem('adminSettings', JSON.stringify(settings));
    showAlert('success', '✅ Configurações guardadas!', 'settingsAlert');
};

// Load settings
function loadSettings() {
    const savedSettings = localStorage.getItem('adminSettings');
    if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        document.getElementById('notificationEmail').value = settings.notificationEmail || 'admin@desire.pt';
        document.getElementById('defaultMargin').value = settings.defaultMargin || 150;
        document.getElementById('autoOrderEmail').checked = settings.autoOrderEmail !== false;
    }
}

// Tab Navigation
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        showTab(tabName);
    });
});

window.showTab = (tabName) => {
    // Update active tab
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Show/hide content
    document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));
    document.getElementById(`${tabName}-tab`).classList.remove('hidden');

    // Load data if needed
    if (tabName === 'orders') {
        loadOrders();
    } else if (tabName === 'products') {
        loadDropshipProducts();
    } else if (tabName === 'settings') {
        loadSettings();
    }
};

// Utility Functions
function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
        overlay.classList.remove('hidden');
        appState.loading = true;
    } else {
        overlay.classList.add('hidden');
        appState.loading = false;
    }
}

function showAlert(type, message, containerId = 'alertContainer') {
    const alertTypes = {
        success: 'alert-success',
        error: 'alert-error',
        warning: 'alert-warning',
        info: 'alert-info'
    };

    const alertClass = alertTypes[type] || 'alert-info';
    const alertHtml = `<div class="alert ${alertClass}">${message}</div>`;

    const container = document.getElementById(containerId);
    if (container) {
        container.innerHTML = alertHtml;

        // Auto remove after 5 seconds
        setTimeout(() => {
            if (container.innerHTML === alertHtml) {
                container.innerHTML = '';
            }
        }, 5000);
    }
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        closeTrackingModal();
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeTrackingModal();
    }
});

// Global error handler
window.addEventListener('error', (e) => {
    console.error('Global error:', e.error);
    showAlert('error', '❌ Ocorreu um erro inesperado.');
});

export function adminInit(_auth, _db, _functions) {
    auth = _auth;
    db = _db;
    functions = _functions;
    window.currentUser = auth.currentUser;
    if(window.currentUser) {
        document.getElementById('adminUserEmail').textContent = window.currentUser.email;
    }
    document.getElementById('adminLogoutBtn').addEventListener('click', () => {
        auth.signOut().then(() => {
            window.location.hash = '/';
        });
    });
    initializeAdmin();
}

console.log('🔥 Desire Admin Panel Loaded Successfully!');