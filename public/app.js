const state = {
  products: [],
  productById: new Map(),
  section: "Food",
  category: "",
  search: "",
  visibleCount: 36,
  cart: loadCart(),
  checkoutOpen: false,
  submitting: false,
  user: null,
  accountMode: "login",
};

const els = {
  productGrid: document.querySelector("#productGrid"),
  productCardTemplate: document.querySelector("#productCardTemplate"),
  cartItemTemplate: document.querySelector("#cartItemTemplate"),
  resultsText: document.querySelector("#resultsText"),
  emptyState: document.querySelector("#emptyState"),
  loadMoreButton: document.querySelector("#loadMoreButton"),
  categorySelect: document.querySelector("#categorySelect"),
  searchInput: document.querySelector("#searchInput"),
  clearSearchButton: document.querySelector("#clearSearchButton"),
  resetFiltersButton: document.querySelector("#resetFiltersButton"),
  emptyResetButton: document.querySelector("#emptyResetButton"),
  tabs: [...document.querySelectorAll(".section-tab")],
  headerCartButton: document.querySelector("#headerCartButton"),
  heroCartButton: document.querySelector("#heroCartButton"),
  floatingCartButton: document.querySelector("#floatingCartButton"),
  headerCartCount: document.querySelector("#headerCartCount"),
  floatingCartCount: document.querySelector("#floatingCartCount"),
  floatingCartTotal: document.querySelector("#floatingCartTotal"),
  cartDrawer: document.querySelector("#cartDrawer"),
  drawerBackdrop: document.querySelector("#drawerBackdrop"),
  closeDrawerButton: document.querySelector("#closeDrawerButton"),
  cartItems: document.querySelector("#cartItems"),
  cartEmpty: document.querySelector("#cartEmpty"),
  continueShoppingButton: document.querySelector("#continueShoppingButton"),
  drawerTotal: document.querySelector("#drawerTotal"),
  checkoutButton: document.querySelector("#checkoutButton"),
  submitOrderButton: document.querySelector("#submitOrderButton"),
  checkoutForm: document.querySelector("#checkoutForm"),
  checkoutStep: document.querySelector("#checkoutStep"),
  cartStep: document.querySelector("#cartStep"),
  backToCartButton: document.querySelector("#backToCartButton"),
  drawerTitle: document.querySelector("#drawerTitle"),
  formError: document.querySelector("#formError"),
  successModal: document.querySelector("#successModal"),
  successCloseButton: document.querySelector("#successCloseButton"),
  toast: document.querySelector("#toast"),
  deliveryDateInput: document.querySelector("#deliveryDateInput"),
  heroProductCount: document.querySelector("#heroProductCount"),
  foodCountHero: document.querySelector("#foodCountHero"),
  nonfoodCountHero: document.querySelector("#nonfoodCountHero"),
  foodTabCount: document.querySelector("#foodTabCount"),
  nonfoodTabCount: document.querySelector("#nonfoodTabCount"),
  headerAccountButton: document.querySelector("#headerAccountButton"),
  headerAccountLabel: document.querySelector("#headerAccountLabel"),
  accountModal: document.querySelector("#accountModal"),
  accountModalClose: document.querySelector("#accountModalClose"),
  accountTabLogin: document.querySelector("#accountTabLogin"),
  accountTabRegister: document.querySelector("#accountTabRegister"),
  loginForm: document.querySelector("#loginForm"),
  registerForm: document.querySelector("#registerForm"),
  loginError: document.querySelector("#loginError"),
  registerError: document.querySelector("#registerError"),
  accountLoggedOut: document.querySelector("#accountLoggedOut"),
  accountLoggedIn: document.querySelector("#accountLoggedIn"),
  accountCompany: document.querySelector("#accountCompany"),
  accountContact: document.querySelector("#accountContact"),
  accountPhone: document.querySelector("#accountPhone"),
  accountOrdersEmpty: document.querySelector("#accountOrdersEmpty"),
  accountOrdersList: document.querySelector("#accountOrdersList"),
  accountLogoutButton: document.querySelector("#accountLogoutButton"),
};

init();

async function init() {
  bindEvents();
  setMinimumDeliveryDate();

  try {
   const response = await fetch("./data/products.json", { cache: "no-cache" });
    if (!response.ok) throw new Error("Не вдалося завантажити каталог");
    state.products = await response.json();
    state.productById = new Map(state.products.map((product) => [product.id, product]));
    pruneCart();
    updateCatalogCounts();
    populateCategories();
    renderProducts();
    renderCart();
    refreshSession();
  } catch (error) {
    els.resultsText.textContent = "Не вдалося завантажити каталог.";
    els.emptyState.hidden = false;
    els.emptyState.querySelector("h3").textContent = "Каталог тимчасово недоступний";
    els.emptyState.querySelector("p").textContent = "Оновіть сторінку або спробуйте пізніше.";
    console.error(error);
  }
}

function bindEvents() {
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.section = tab.dataset.section;
      state.category = "";
      state.visibleCount = 36;
      els.tabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", String(active));
      });
      populateCategories();
      renderProducts();
    });
  });

  let searchTimer;
  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    els.searchInput.closest(".search-field").classList.toggle("has-value", Boolean(els.searchInput.value));
    searchTimer = setTimeout(() => {
      state.search = els.searchInput.value.trim();
      state.visibleCount = 36;
      renderProducts();
    }, 160);
  });

  els.clearSearchButton.addEventListener("click", () => {
    els.searchInput.value = "";
    state.search = "";
    state.visibleCount = 36;
    els.searchInput.closest(".search-field").classList.remove("has-value");
    els.searchInput.focus();
    renderProducts();
  });

  els.categorySelect.addEventListener("change", () => {
    state.category = els.categorySelect.value;
    state.visibleCount = 36;
    renderProducts();
  });

  [els.resetFiltersButton, els.emptyResetButton].forEach((button) => {
    button.addEventListener("click", resetFilters);
  });

  els.loadMoreButton.addEventListener("click", () => {
    state.visibleCount += 36;
    renderProducts({ preserveScroll: true });
  });

  [els.headerCartButton, els.heroCartButton, els.floatingCartButton].forEach((button) => {
    button.addEventListener("click", openDrawer);
  });
  els.closeDrawerButton.addEventListener("click", closeDrawer);
  els.drawerBackdrop.addEventListener("click", closeDrawer);
  els.continueShoppingButton.addEventListener("click", () => {
    closeDrawer();
    document.querySelector("#catalog").scrollIntoView({ behavior: "smooth" });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!els.successModal.hidden) closeSuccess();
      else if (!els.accountModal.hidden) closeAccountModal();
      else if (els.cartDrawer.classList.contains("is-open")) closeDrawer();
    }
  });

  els.checkoutButton.addEventListener("click", showCheckout);

  els.headerAccountButton.addEventListener("click", () => {
    if (state.user) openAccountModal();
    else openAccountModal("login");
  });
  els.accountModalClose.addEventListener("click", closeAccountModal);
  els.accountModal.addEventListener("click", (event) => {
    if (event.target === els.accountModal) closeAccountModal();
  });
  els.accountTabLogin.addEventListener("click", () => setAccountMode("login"));
  els.accountTabRegister.addEventListener("click", () => setAccountMode("register"));
  els.loginForm.addEventListener("submit", submitLogin);
  els.registerForm.addEventListener("submit", submitRegister);
  els.accountLogoutButton.addEventListener("click", logout);
  els.backToCartButton.addEventListener("click", showCartStep);
  els.checkoutForm.addEventListener("submit", submitOrder);
  els.checkoutForm.addEventListener("input", (event) => {
    event.target.classList.remove("is-invalid");
    hideFormError();
  });
  els.successCloseButton.addEventListener("click", closeSuccess);
}

function updateCatalogCounts() {
  const food = state.products.filter((product) => product.section === "Food").length;
  const nonfood = state.products.filter((product) => product.section === "NONFood").length;
  els.heroProductCount.textContent = String(state.products.length);
  els.foodCountHero.textContent = `${food} ${pluralize(food, ["позиція", "позиції", "позицій"])}`;
  els.nonfoodCountHero.textContent = `${nonfood} ${pluralize(nonfood, ["позиція", "позиції", "позицій"])}`;
  els.foodTabCount.textContent = String(food);
  els.nonfoodTabCount.textContent = String(nonfood);
}

function populateCategories() {
  const categories = [];
  const seen = new Set();
  for (const product of state.products) {
    if (product.section !== state.section || seen.has(product.category)) continue;
    seen.add(product.category);
    categories.push(product.category);
  }

  els.categorySelect.replaceChildren(new Option("Усі категорії", ""));
  for (const category of categories) {
    els.categorySelect.add(new Option(toTitleCase(category), category));
  }
  els.categorySelect.value = state.category;
}

function getFilteredProducts() {
  const query = normalizeSearch(state.search);
  return state.products.filter((product) => {
    if (product.section !== state.section) return false;
    if (state.category && product.category !== state.category) return false;
    if (!query) return true;

    return matchesSearch(
      `${product.name} ${product.category} ${product.parentCategory}`,
      query,
    );
  });
}

function renderProducts() {
  const filtered = getFilteredProducts();
  const visible = filtered.slice(0, state.visibleCount);
  const fragment = document.createDocumentFragment();

  for (const product of visible) {
    const card = els.productCardTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.productId = product.id;
    const symbol = card.querySelector(".product-symbol");
    const image = card.querySelector(".product-image");
    const visual = card.querySelector(".product-visual");
    symbol.textContent = getCategoryEmoji(product);
    visual.classList.add(`product-visual--${getCategoryColor(product)}`);
    if (product.image) {
      image.src = "." + product.image;
      image.src = product.image;
      image.alt = product.name;
      image.hidden = false;
      symbol.hidden = true;
      image.addEventListener("error", () => {
        image.hidden = true;
        symbol.hidden = false;
      }, { once: true });
    }
    card.querySelector(".product-category").textContent = toTitleCase(product.category);
    card.querySelector(".product-name").textContent = product.name;
    const packSize = getPackSize(product);
    const priceLabel = card.querySelector(".product-price-wrap span");
    card.querySelector(".product-price").textContent = formatMoney(product.price);
    if (packSize > 1 && product.priceBasis === "pack") {
      priceLabel.textContent = `за уп. · ${packSize} шт`;
    } else if (packSize > 1) {
      priceLabel.textContent = `за шт. · уп. ${packSize} шт = ${formatMoney(getLineTotal(product, packSize))}`;
    } else {
      priceLabel.textContent = "за од.";
    }

    const addButton = card.querySelector(".add-button");
    if (state.cart[product.id]) {
      addButton.classList.add("is-added");
      addButton.textContent = formatCartButtonQuantity(product, state.cart[product.id]);
    }
    addButton.addEventListener("click", () => addToCart(product.id, addButton));
    fragment.append(card);
  }

  els.productGrid.replaceChildren(fragment);
  els.emptyState.hidden = filtered.length > 0;
  els.productGrid.hidden = filtered.length === 0;
  els.loadMoreButton.hidden = state.visibleCount >= filtered.length;
  els.resultsText.textContent = filtered.length
    ? `Знайдено ${filtered.length} ${pluralize(filtered.length, ["товар", "товари", "товарів"])} · показано ${visible.length}`
    : "За вибраними параметрами товарів немає";
}

function resetFilters() {
  state.category = "";
  state.search = "";
  state.visibleCount = 36;
  els.categorySelect.value = "";
  els.searchInput.value = "";
  els.searchInput.closest(".search-field").classList.remove("has-value");
  renderProducts();
}

function addToCart(productId, button) {
  const product = state.productById.get(productId);
  if (!product) return;
  const step = getPackSize(product);
  const maxQuantity = getMaxQuantity(product);
  state.cart[productId] = Math.min(maxQuantity, (state.cart[productId] || 0) + step);
  saveCart();
  renderCart();
  button.classList.add("is-added");
  button.textContent = formatCartButtonQuantity(product, state.cart[productId]);
  showToast(step > 1 ? `Додано упаковку: ${step} шт` : "Товар додано до кошика");
}

function renderCart() {
  const entries = getCartEntries();
  const fragment = document.createDocumentFragment();

  for (const { product, quantity } of entries) {
    const item = els.cartItemTemplate.content.firstElementChild.cloneNode(true);
    item.dataset.productId = product.id;
    item.querySelector(".cart-item-section").textContent = `${product.section} · ${toTitleCase(product.category)}`;
    item.querySelector(".cart-item-name").textContent = product.name;
    const packSize = getPackSize(product);
    if (packSize > 1 && product.priceBasis === "pack") {
      item.querySelector(".cart-item-price").textContent =
        `${formatMoney(product.price)} за упаковку · ${packSize} шт`;
    } else if (packSize > 1) {
      item.querySelector(".cart-item-price").textContent =
        `${formatMoney(product.price)} за шт. · упаковка ${packSize} шт`;
    } else {
      item.querySelector(".cart-item-price").textContent = `${formatMoney(product.price)} за од.`;
    }
    item.querySelector(".cart-item-total").textContent = formatMoney(getLineTotal(product, quantity));

    const input = item.querySelector(".quantity-input");
    input.value = quantity;
    input.min = String(packSize);
    input.step = String(packSize);
    input.max = String(getMaxQuantity(product));
    input.addEventListener("change", () => updateQuantity(product.id, input.value));
    input.addEventListener("blur", () => { input.value = state.cart[product.id] || packSize; });
    item.querySelector(".quantity-minus").addEventListener("click", () => updateQuantity(product.id, quantity - packSize));
    item.querySelector(".quantity-plus").addEventListener("click", () => updateQuantity(product.id, quantity + packSize));
    item.querySelector(".cart-remove").addEventListener("click", () => removeFromCart(product.id));
    fragment.append(item);
  }

  els.cartItems.replaceChildren(fragment);
  els.cartEmpty.hidden = entries.length > 0;
  els.cartItems.hidden = entries.length === 0;
  els.checkoutButton.disabled = entries.length === 0;

  const units = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  const total = entries.reduce((sum, entry) => sum + getLineTotal(entry.product, entry.quantity), 0);
  els.headerCartCount.textContent = String(units);
  els.floatingCartCount.textContent = String(units);
  els.floatingCartTotal.textContent = formatMoney(total);
  els.drawerTotal.textContent = formatMoney(total);
  els.floatingCartButton.hidden = units === 0 || els.cartDrawer.classList.contains("is-open");

  if (!entries.length && state.checkoutOpen) showCartStep();
  updateVisibleProductButtons();
}

function updateQuantity(productId, value) {
  const product = state.productById.get(productId);
  if (!product) return;
  state.cart[productId] = normalizeQuantity(product, value);
  saveCart();
  renderCart();
}

function removeFromCart(productId) {
  delete state.cart[productId];
  saveCart();
  renderCart();
  showToast("Товар видалено з кошика");
}

function getCartEntries() {
  return Object.entries(state.cart)
    .map(([id, quantity]) => ({ product: state.productById.get(id), quantity }))
    .filter((entry) => entry.product && Number.isInteger(entry.quantity) && entry.quantity > 0);
}

function updateVisibleProductButtons() {
  document.querySelectorAll(".product-card").forEach((card) => {
    const id = card.dataset.productId;
    const button = card.querySelector(".add-button");
    const quantity = state.cart[id];
    button.classList.toggle("is-added", Boolean(quantity));
    button.textContent = quantity ? formatCartButtonQuantity(state.productById.get(id), quantity) : "Додати";
  });
}

function openDrawer() {
  els.drawerBackdrop.hidden = false;
  requestAnimationFrame(() => {
    els.drawerBackdrop.classList.add("is-open");
    els.cartDrawer.classList.add("is-open");
  });
  els.cartDrawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  els.floatingCartButton.hidden = true;
  setTimeout(() => els.closeDrawerButton.focus(), 150);
}

function closeDrawer() {
  els.drawerBackdrop.classList.remove("is-open");
  els.cartDrawer.classList.remove("is-open");
  els.cartDrawer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  setTimeout(() => {
    els.drawerBackdrop.hidden = true;
    renderCart();
  }, 280);
}

function showCheckout() {
  if (!getCartEntries().length) return;
  prefillCheckoutFromAccount();
  state.checkoutOpen = true;
  els.cartStep.hidden = true;
  els.checkoutStep.hidden = false;
  els.checkoutButton.hidden = true;
  els.submitOrderButton.hidden = false;
  els.drawerTitle.textContent = "Оформлення";
  els.cartDrawer.querySelector(".drawer-content").scrollTo({ top: 0, behavior: "smooth" });
  setTimeout(() => els.checkoutForm.elements.company.focus(), 100);
}

function showCartStep() {
  state.checkoutOpen = false;
  els.cartStep.hidden = false;
  els.checkoutStep.hidden = true;
  els.checkoutButton.hidden = false;
  els.submitOrderButton.hidden = true;
  els.drawerTitle.textContent = "Кошик";
  hideFormError();
}

async function refreshSession() {
  try {
    const response = await fetch("/api/auth/me");
    const result = await response.json().catch(() => ({}));
    state.user = result.user || null;
  } catch {
    state.user = null;
  }
  renderAccountHeader();
}

function renderAccountHeader() {
  els.headerAccountLabel.textContent = state.user ? state.user.contact.split(" ")[0] : "Увійти";
}

function openAccountModal(mode) {
  if (state.user) {
    els.accountLoggedOut.hidden = true;
    els.accountLoggedIn.hidden = false;
    els.accountCompany.textContent = state.user.company;
    els.accountContact.textContent = state.user.contact;
    els.accountPhone.textContent = formatPhone(state.user.phone);
    loadAccountOrders();
  } else {
    els.accountLoggedOut.hidden = false;
    els.accountLoggedIn.hidden = true;
    setAccountMode(mode || state.accountMode);
  }
  els.accountModal.hidden = false;
  document.body.classList.add("drawer-open");
}

function closeAccountModal() {
  els.accountModal.hidden = true;
  if (!els.cartDrawer.classList.contains("is-open")) {
    document.body.classList.remove("drawer-open");
  }
}

function setAccountMode(mode) {
  state.accountMode = mode;
  const isLogin = mode === "login";
  els.accountTabLogin.classList.toggle("is-active", isLogin);
  els.accountTabRegister.classList.toggle("is-active", !isLogin);
  els.loginForm.hidden = !isLogin;
  els.registerForm.hidden = isLogin;
}

async function submitLogin(event) {
  event.preventDefault();
  const formData = new FormData(els.loginForm);
  const payload = Object.fromEntries(formData.entries());
  els.loginError.hidden = true;

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "Не вдалося увійти");

    state.user = result.user;
    els.loginForm.reset();
    renderAccountHeader();
    prefillCheckoutFromAccount();
    openAccountModal();
  } catch (error) {
    els.loginError.textContent = error.message;
    els.loginError.hidden = false;
  }
}

async function submitRegister(event) {
  event.preventDefault();
  const formData = new FormData(els.registerForm);
  const payload = Object.fromEntries(formData.entries());
  els.registerError.hidden = true;

  try {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "Не вдалося зареєструватися");

    state.user = result.user;
    els.registerForm.reset();
    renderAccountHeader();
    prefillCheckoutFromAccount();
    openAccountModal();
  } catch (error) {
    els.registerError.textContent = error.message;
    els.registerError.hidden = false;
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Best-effort — the cookie may already be gone.
  }
  state.user = null;
  renderAccountHeader();
  closeAccountModal();
  showToast("Ви вийшли з акаунту");
}

function prefillCheckoutFromAccount() {
  if (!state.user || !els.checkoutForm) return;
  els.checkoutForm.elements.company.value ||= state.user.company;
  els.checkoutForm.elements.contact.value ||= state.user.contact;
  els.checkoutForm.elements.phone.value ||= formatPhone(state.user.phone);
}

async function loadAccountOrders() {
  els.accountOrdersList.textContent = "Завантаження…";
  els.accountOrdersEmpty.hidden = true;
  try {
    const response = await fetch("/api/orders");
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "Не вдалося завантажити замовлення");
    renderAccountOrders(result.orders || []);
  } catch (error) {
    els.accountOrdersList.textContent = "";
    els.accountOrdersEmpty.textContent = error.message || "Не вдалося завантажити замовлення.";
    els.accountOrdersEmpty.hidden = false;
  }
}

function renderAccountOrders(orders) {
  els.accountOrdersList.replaceChildren();
  if (!orders.length) {
    els.accountOrdersEmpty.textContent = "Замовлень поки немає.";
    els.accountOrdersEmpty.hidden = false;
    return;
  }
  els.accountOrdersEmpty.hidden = true;

  const fragment = document.createDocumentFragment();
  for (const order of orders) {
    const card = document.createElement("div");
    card.className = "account-order";

    const head = document.createElement("div");
    head.className = "account-order-head";
    const idEl = document.createElement("strong");
    idEl.textContent = order.id;
    const dateEl = document.createElement("span");
    dateEl.textContent = order.orderTime || "";
    head.append(idEl, dateEl);

    const itemsEl = document.createElement("p");
    itemsEl.className = "account-order-items";
    itemsEl.textContent = order.items.map((item) => `${item.name} × ${item.quantity}`).join(", ");

    const totalEl = document.createElement("strong");
    totalEl.className = "account-order-total";
    totalEl.textContent = formatMoney(order.total);

    card.append(head, itemsEl, totalEl);
    fragment.append(card);
  }
  els.accountOrdersList.append(fragment);
}

function formatPhone(digits) {
  const value = String(digits || "");
  return value.startsWith("380") ? `+${value}` : value;
}

async function submitOrder(event) {
  event.preventDefault();
  if (state.submitting) return;
  if (!validateForm()) return;

  const formData = new FormData(els.checkoutForm);
  const customer = Object.fromEntries(formData.entries());
  const items = getCartEntries().map(({ product, quantity }) => ({ id: product.id, quantity }));

  state.submitting = true;
  els.submitOrderButton.disabled = true;
  els.submitOrderButton.classList.add("is-loading");
  hideFormError();

  try {
    const response = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer, items, website: customer.website || "" }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Не вдалося відправити замовлення");
    }

    state.cart = {};
    saveCart();
    renderCart();
    els.checkoutForm.reset();
    setMinimumDeliveryDate();
    closeDrawer();
    if (state.user && !els.accountModal.hidden) loadAccountOrders();
    setTimeout(() => {
      els.successModal.hidden = false;
      document.body.classList.add("drawer-open");
      els.successCloseButton.focus();
    }, 300);
  } catch (error) {
    showFormError(error.message || "Не вдалося відправити замовлення. Спробуйте ще раз.");
  } finally {
    state.submitting = false;
    els.submitOrderButton.disabled = false;
    els.submitOrderButton.classList.remove("is-loading");
  }
}

function validateForm() {
  const required = ["company", "contact", "phone", "city", "street", "house"];
  let firstInvalid = null;
  for (const name of required) {
    const input = els.checkoutForm.elements[name];
    const valid = Boolean(input.value.trim());
    input.classList.toggle("is-invalid", !valid);
    if (!valid && !firstInvalid) firstInvalid = input;
  }

  const phoneInput = els.checkoutForm.elements.phone;
  const phoneDigits = phoneInput.value.replace(/\D/g, "");
  if (phoneDigits.length < 9 || phoneDigits.length > 15) {
    phoneInput.classList.add("is-invalid");
    firstInvalid ||= phoneInput;
  }

  if (firstInvalid) {
    showFormError("Заповніть обов’язкові поля та перевірте номер телефону.");
    firstInvalid.focus();
    return false;
  }
  return true;
}

function showFormError(message) {
  els.formError.textContent = message;
  els.formError.hidden = false;
  els.formError.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideFormError() {
  els.formError.hidden = true;
  els.formError.textContent = "";
}

function closeSuccess() {
  els.successModal.hidden = true;
  document.body.classList.remove("drawer-open");
  showCartStep();
  document.querySelector("#catalog").scrollIntoView({ behavior: "smooth" });
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add("is-visible"));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.classList.remove("is-visible");
    setTimeout(() => { els.toast.hidden = true; }, 200);
  }, 1700);
}

function saveCart() {
  localStorage.setItem("berta-horeca-cart", JSON.stringify(state.cart));
}

function loadCart() {
  try {
    const parsed = JSON.parse(localStorage.getItem("berta-horeca-cart") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pruneCart() {
  for (const [id, value] of Object.entries(state.cart)) {
    const product = state.productById.get(id);
    const quantity = Number(value);
    if (!product || !Number.isFinite(quantity) || quantity < 1) delete state.cart[id];
    else state.cart[id] = normalizeQuantity(product, quantity);
  }
  saveCart();
}

function getPackSize(product) {
  const packSize = Math.round(Number(product?.packSize) || 1);
  return Math.max(1, packSize);
}

function getMaxQuantity(product) {
  return Math.min(999999, getPackSize(product) * 999);
}

function normalizeQuantity(product, value) {
  const step = getPackSize(product);
  const raw = Math.max(step, Number(value) || step);
  const packages = Math.max(1, Math.round(raw / step));
  return Math.min(getMaxQuantity(product), packages * step);
}

function getLineTotal(product, quantity) {
  const packSize = getPackSize(product);
  if (packSize > 1 && product.priceBasis === "pack") {
    return product.price * (quantity / packSize);
  }
  return product.price * quantity;
}

function formatCartButtonQuantity(product, quantity) {
  const packSize = getPackSize(product);
  return packSize > 1 ? `У кошику: ${quantity} шт` : `У кошику: ${quantity}`;
}

function setMinimumDeliveryDate() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const dd = String(tomorrow.getDate()).padStart(2, "0");
  els.deliveryDateInput.min = `${yyyy}-${mm}-${dd}`;
}

function formatMoney(value) {
  return `${Number(value).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} грн`;
}

function normalizeSearch(value) {
  return String(value || "")
    .toLocaleLowerCase("uk-UA")
    .normalize("NFKD")
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Пошук не залежить від порядку слів, підтримує частини слів і одну невелику помилку.
// Наприклад, "Олія Pros" знайде "PROSMAZH Олія РВД 5 л".
function matchesSearch(value, normalizedQuery) {
  const searchText = normalizeSearch(value);
  const searchWords = searchText.split(" ").filter(Boolean);
  const queryWords = normalizeSearch(normalizedQuery).split(" ").filter(Boolean);

  return queryWords.every((queryWord) => {
    if (searchText.includes(queryWord)) return true;

    return searchWords.some((searchWord) => {
      if (searchWord.startsWith(queryWord)) return true;
      if (queryWord.length < 4) return false;

      const prefix = searchWord.slice(0, queryWord.length);
      return isWithinOneEdit(prefix, queryWord);
    });
  });
}

function isWithinOneEdit(first, second) {
  if (first === second) return true;
  if (Math.abs(first.length - second.length) > 1) return false;

  let firstIndex = 0;
  let secondIndex = 0;
  let edits = 0;

  while (firstIndex < first.length && secondIndex < second.length) {
    if (first[firstIndex] === second[secondIndex]) {
      firstIndex += 1;
      secondIndex += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) return false;

    if (first.length > second.length) firstIndex += 1;
    else if (second.length > first.length) secondIndex += 1;
    else {
      firstIndex += 1;
      secondIndex += 1;
    }
  }

  if (firstIndex < first.length || secondIndex < second.length) edits += 1;
  return edits <= 1;
}

function toTitleCase(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const lower = text.toLocaleLowerCase("uk-UA");
  return lower.charAt(0).toLocaleUpperCase("uk-UA") + lower.slice(1);
}

function getCategoryEmoji(product) {
  const text = `${product.category} ${product.parentCategory}`.toLocaleLowerCase("uk-UA");
  const rules = [
    [/олія|соус|майонез|кетчуп|оцет/, "🫙"],
    [/макарон|бакалі|консерва|спец|приправа|дріждж/, "🥫"],
    [/сироп|напої|соки|чай|пюре|топінг/, "🥤"],
    [/кондитер|снек/, "🍪"],
    [/стакан|таріл|посуд|прибор/, "🍽️"],
    [/пакет|упаков|короб|блістер|ланч|фольг/, "📦"],
    [/хім|дезін|мило|миття|чищення|підлоги|ванної/, "🧴"],
    [/рукавич/, "🧤"],
    [/папер|сервет|рушник|туалет/, "🧻"],
    [/прибиран|скребок/, "🧹"],
    [/касов|стріч/, "🧾"],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || (product.section === "Food" ? "🍴" : "🧰");
}

function getCategoryColor(product) {
  const text = `${product.category} ${product.parentCategory}`.toLocaleLowerCase("uk-UA");
  const rules = [
    [/олія|соус|майонез|кетчуп|оцет/, "amber"],
    [/макарон|бакалі|консерва|спец|приправа|дріждж/, "sand"],
    [/сироп|напої|соки|чай|пюре|топінг/, "teal"],
    [/кондитер|снек/, "pink"],
    [/стакан|таріл|посуд|прибор/, "blue"],
    [/пакет|упаков|короб|блістер|ланч|фольг/, "violet"],
    [/хім|дезін|мило|миття|чищення|підлоги|ванної/, "green"],
    [/рукавич/, "orange"],
    [/папер|сервет|рушник|туалет/, "sand"],
    [/прибиран|скребок/, "green"],
    [/касов|стріч/, "blue"],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || (product.section === "Food" ? "amber" : "blue");
}

function pluralize(number, forms) {
  const n = Math.abs(number) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}
