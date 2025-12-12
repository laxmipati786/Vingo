import Item from "../models/item.model.js";
import Shop from "../models/shop.model.js";
import uploadOnCloudinary from "../utils/cloudinary.js";
import NodeCache from "node-cache";

// Simple in-memory cache to reduce DB hits for frequent reads
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 minutes

// Projections to fetch only required fields
const itemProjection = {
  name: 1,
  category: 1,
  foodType: 1,
  price: 1,
  image: 1,
  rating: 1,
  shop: 1,
};

const shopProjection = {
  name: 1,
  image: 1,
  city: 1,
};

export const addItem = async (req, res) => {
  try {
    const { name, category, foodType, price } = req.body;
    let image;
    if (req.file) {
      image = await uploadOnCloudinary(req.file.path);
    }
    const shop = await Shop.findOne({ owner: req.userId });
    if (!shop) {
      return res.status(400).json({ message: "shop not found" });
    }
    const item = await Item.create({
      name,
      category,
      foodType,
      price,
      image,
      shop: shop._id,
    });

    shop.items.push(item._id);
    await shop.save();
    await shop.populate("owner");
    await shop.populate({
      path: "items",
      options: { sort: { updatedAt: -1 } },
    });
    return res.status(201).json(shop);
  } catch (error) {
    return res.status(500).json({ message: `add item error ${error}` });
  }
};

export const editItem = async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const { name, category, foodType, price } = req.body;
    let image;
    if (req.file) {
      image = await uploadOnCloudinary(req.file.path);
    }
    const item = await Item.findByIdAndUpdate(
      itemId,
      {
        name,
        category,
        foodType,
        price,
        image,
      },
      { new: true }
    );
    if (!item) {
      return res.status(400).json({ message: "item not found" });
    }
    const shop = await Shop.findOne({ owner: req.userId }).populate({
      path: "items",
      options: { sort: { updatedAt: -1 } },
    });
    return res.status(200).json(shop);
  } catch (error) {
    return res.status(500).json({ message: `edit item error ${error}` });
  }
};

export const getItemById = async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const item = await Item.findById(itemId);
    if (!item) {
      return res.status(400).json({ message: "item not found" });
    }
    return res.status(200).json(item);
  } catch (error) {
    return res.status(500).json({ message: `get item error ${error}` });
  }
};

export const deleteItem = async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const item = await Item.findByIdAndDelete(itemId);
    if (!item) {
      return res.status(400).json({ message: "item not found" });
    }
    const shop = await Shop.findOne({ owner: req.userId });
    shop.items = shop.items.filter((i) => i !== item._id);
    await shop.save();
    await shop.populate({
      path: "items",
      options: { sort: { updatedAt: -1 } },
    });
    return res.status(200).json(shop);
  } catch (error) {
    return res.status(500).json({ message: `delete item error ${error}` });
  }
};

export const getItemByCity = async (req, res) => {
  try {
    const { city } = req.params;
    if (!city) {
      return res.status(400).json({ message: "city is required" });
    }
    // Try cache first
    const cacheKey = `items_city_${city.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.status(200).json(cached);

    // Get shop ids in the city (lean + projection)
    const shops = await Shop.find({
      city: { $regex: new RegExp(`^${city}$`, "i") },
    })
      .select("_id name image")
      .lean();

    if (!shops || shops.length === 0) {
      return res.status(404).json({ message: "No shops found in this city" });
    }

    const shopIds = shops.map((s) => s._id);

    // Fetch items with projection + lean, limit to first 50 for initial load
    const items = await Item.find({ shop: { $in: shopIds } })
      .select(itemProjection)
      .lean()
      .limit(50)
      .sort({ "rating.average": -1 });

    // Attach minimal shop info to items to avoid populate
    const shopMap = Object.fromEntries(
      shops.map((s) => [s._id.toString(), { name: s.name, image: s.image }])
    );
    const itemsWithShop = items.map((it) => ({
      ...it,
      shopInfo: shopMap[it.shop.toString()] || null,
    }));

    cache.set(cacheKey, itemsWithShop);
    return res.status(200).json(itemsWithShop);
  } catch (error) {
    return res.status(500).json({ message: `get item by city error ${error}` });
  }
};

export const getItemsByShop = async (req, res) => {
  try {
    const { shopId } = req.params;
    // cache key
    const cacheKey = `shop_items_${shopId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.status(200).json(cached);

    // Run shop and items queries in parallel with lean + projections
    const [shop, items] = await Promise.all([
      Shop.findById(shopId).select(shopProjection).lean(),
      Item.find({ shop: shopId }).select(itemProjection).lean(),
    ]);

    if (!shop) {
      return res.status(404).json({ message: "shop not found" });
    }

    const response = { shop, items };
    cache.set(cacheKey, response);
    return res.status(200).json(response);
  } catch (error) {
    return res.status(500).json({ message: `get item by shop error ${error}` });
  }
};

export const searchItems = async (req, res) => {
  try {
    const { query, city } = req.query;
    if (!query || !city) {
      return null;
    }
    // cache search
    const cacheKey = `search_${city.toLowerCase()}_${query.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.status(200).json(cached);

    // Find shop ids in city (lean + projection)
    const shops = await Shop.find({
      city: { $regex: new RegExp(`^${city}$`, "i") },
    })
      .select("_id")
      .lean();

    if (!shops || shops.length === 0) {
      return res.status(404).json({ message: "shops not found" });
    }

    const shopIds = shops.map((s) => s._id);

    const items = await Item.find({
      shop: { $in: shopIds },
      $or: [
        { name: { $regex: query, $options: "i" } },
        { category: { $regex: query, $options: "i" } },
      ],
    })
      .select(itemProjection)
      .lean()
      .limit(25)
      .sort({ "rating.average": -1 });

    cache.set(cacheKey, items);
    return res.status(200).json(items);
  } catch (error) {
    return res.status(500).json({ message: `search item  error ${error}` });
  }
};

export const rating = async (req, res) => {
  try {
    const { itemId, rating } = req.body;

    if (!itemId || !rating) {
      return res.status(400).json({ message: "itemId and rating is required" });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ message: "rating must be between 1 to 5" });
    }

    const item = await Item.findById(itemId);
    if (!item) {
      return res.status(400).json({ message: "item not found" });
    }

    const newCount = item.rating.count + 1;
    const newAverage =
      (item.rating.average * item.rating.count + rating) / newCount;

    item.rating.count = newCount;
    item.rating.average = newAverage;
    await item.save();
    return res.status(200).json({ rating: item.rating });
  } catch (error) {
    return res.status(500).json({ message: `rating error ${error}` });
  }
};
