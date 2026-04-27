import axios from "axios";

let accessToken = null;

// 🔁 Get new access token
export const getZohoAccessToken = async () => {
  try {
    const res = await axios.post(
      "https://accounts.zoho.in/oauth/v2/token",
      null,
      {
        params: {
          refresh_token: process.env.ZOHO_REFRESH_TOKEN,
          client_id: process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          grant_type: "refresh_token",
        },
      }
    );

    accessToken = res.data.access_token;
    return accessToken;
  } catch (err) {
    console.error("❌ Zoho Token Error:", err.response?.data || err.message);
    throw err;
  }
};

// 🔒 Helper → always get token
const getToken = async () => {
  if (!accessToken) {
    await getZohoAccessToken();
  }
  return accessToken;
};

// 👤 GET OR CREATE CUSTOMER
export const getOrCreateCustomer = async ({ name, code }) => {
  try {
    const token = await getToken();

    // 🔍 Search by contact_number (BEST)
    const search = await axios.get(
      `https://www.zohoapis.in/books/v3/contacts?contact_number=${code}&organization_id=${process.env.ZOHO_ORG_ID}`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      }
    );

    if (search.data.contacts.length > 0) {
      return search.data.contacts[0].contact_id;
    }

    // ➕ Create
    const create = await axios.post(
      `https://www.zohoapis.in/books/v3/contacts?organization_id=${process.env.ZOHO_ORG_ID}`,
      {
        contact_name: name,
        contact_type: "customer",
        contact_number: code, // UNIQUE
      },
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      }
    );

    return create.data.contact.contact_id;
  } catch (err) {
    console.error("❌ Zoho Customer Error:", err.response?.data || err.message);
    throw err;
  }
};

// 📦 GET OR CREATE ITEM
export const getOrCreateItem = async ({ productId, name, price }) => {
  try {
    const token = await getToken();

    // 🔍 Search by SKU
    const search = await axios.get(
      `https://www.zohoapis.in/books/v3/items?sku=${productId}&organization_id=${process.env.ZOHO_ORG_ID}`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      }
    );

    if (search.data.items.length > 0) {
      return search.data.items[0].item_id;
    }

    // ➕ Create item
    const create = await axios.post(
      `https://www.zohoapis.in/books/v3/items?organization_id=${process.env.ZOHO_ORG_ID}`,
      {
        name,
        rate: price,
        sku: productId, // UNIQUE
      },
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      }
    );

    return create.data.item.item_id;
  } catch (err) {
    console.error("❌ Zoho Item Error:", err.response?.data || err.message);
    throw err;
  }
};

// 🧾 CREATE SALES ORDER (DRAFT)
export const createZohoSalesOrder = async ({
  distributorName,
  distributorId,
  items,
}) => {
  try {
    const token = await getToken();

    // ✅ 1. Customer
    const customer_id = await getOrCreateCustomer({
      name: distributorName,
      code: distributorId,
    });

    // ✅ 2. Items
    const line_items = [];

    for (const i of items) {
      const item_id = await getOrCreateItem({
        productId: i.productId,
        name: i.name,
        price: i.price,
      });

      line_items.push({
        item_id,
        quantity: i.qty,
      });
    }

    // ✅ 3. Create Order
    const res = await axios.post(
      `https://www.zohoapis.in/books/v3/salesorders?organization_id=${process.env.ZOHO_ORG_ID}`,
      {
        customer_id,
        line_items,
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
        },
      }
    );

    return res.data;
  } catch (err) {
    console.error("❌ Zoho Order Error:", err.response?.data || err.message);
    throw err;
  }
};