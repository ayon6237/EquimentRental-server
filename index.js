require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const User = require('./models/User');
const Equipment = require('./models/Equipment');
const Booking = require('./models/Booking');
const Payment = require('./models/Payment');

const app = express();
const port = process.env.PORT || 5000;

const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');

const allowedOrigins = [
  'http://localhost:3000',
  'https://my-app-azure-gamma-33.vercel.app',
  clientUrl,
].filter(Boolean);

const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
};

// Basic Middlewares
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json());
app.use(cookieParser());

// Serverless-Safe MongoDB Connection
let cachedConnection = null;

async function connectDB() {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }
  cachedConnection = await mongoose.connect(process.env.MONGODB_URI, {
    bufferCommands: false,
    serverSelectionTimeoutMS: 5000,
  });
  console.log('✅ MongoDB Connected Successfully!');
  return cachedConnection;
}

// Ensure DB is connected before every route
app.use(async (req, res, next) => {
  if (req.path === '/') return next();
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    res.status(500).send({ message: 'Database connection failed', error: err.message });
  }
});

// Auth Middlewares
const verifyToken = (req, res, next) => {
  const authHeader = req.headers?.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const token = bearerToken || req.cookies?.token;

  if (!token) return res.status(401).send({ message: 'Unauthorized access' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).send({ message: 'Unauthorized access' });
    req.user = decoded;
    next();
  });
};

const verifyRenter = (req, res, next) => {
  if (req.user.role !== 'Customer') {
    return res.status(403).send({ message: 'Forbidden access! Customer only.' });
  }
  next();
};

const verifyOwner = (req, res, next) => {
  if (req.user.role !== 'Owner') {
    return res.status(403).send({ message: 'Forbidden access! Owner only.' });
  }
  next();
};

const verifyAdmin = (req, res, next) => {
  if (req.user.role !== 'Admin') {
    return res.status(403).send({ message: 'Forbidden access! Admin only.' });
  }
  next();
};

// ================= AUTH & USER ROUTES =================

app.post('/jwt', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    const payload = {
      email,
      role: user ? user.role : 'Customer',
      userId: user ? user._id : null,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, cookieOptions).send({ success: true, token });
  } catch (error) {
    res.status(500).send({ message: 'Failed to generate token', error: error.message });
  }
});

app.post('/logout', (req, res) => {
  res.clearCookie('token', cookieOptions).send({ success: true });
});

app.post('/users', async (req, res) => {
  try {
    const userData = req.body;
    const existingUser = await User.findOne({ email: userData.email });

    if (existingUser) {
      return res.send({ message: 'User already exists', user: existingUser });
    }

    const newUser = await User.create({
      ...userData,
      role: 'Customer',
    });
    res.status(201).send(newUser);
  } catch (error) {
    res.status(500).send({ message: 'Failed to save user', error: error.message });
  }
});

app.get('/users/role/:email', async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email }).select('-password');
    if (!user) return res.status(404).send({ role: 'Customer' });
    res.send({ role: user.role, user });
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch role' });
  }
});

app.patch('/users/profile/:email', verifyToken, async (req, res) => {
  try {
    if (req.user.email !== req.params.email) {
      return res.status(403).send({ message: 'Forbidden access' });
    }
    const { name, photo, phone, address } = req.body;
    const updatedUser = await User.findOneAndUpdate(
      { email: req.params.email },
      { name, photo, phone, address },
      { new: true }
    ).select('-password');

    res.send(updatedUser);
  } catch (error) {
    res.status(500).send({ message: 'Failed to update profile' });
  }
});

app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.send(users);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch users' });
  }
});

app.patch('/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { role } = req.body; // 'Customer', 'Owner', or 'Admin'
    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true }
    ).select('-password');

    res.send(updatedUser);
  } catch (error) {
    res.status(500).send({ message: 'Failed to update role' });
  }
});

app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.send({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).send({ message: 'Failed to delete user' });
  }
});

// ================= EQUIPMENT ROUTES =================

app.get('/equipment/featured', async (req, res) => {
  try {
    const featured = await Equipment.find({ status: 'Approved' })
      .sort({ createdAt: -1 })
      .limit(6)
      .populate('owner', 'name email photo');
    res.send(featured);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch featured equipment' });
  }
});

app.get('/equipment', async (req, res) => {
  try {
    const {
      search = '',
      category = '',
      rentalType = '',
      minPrice,
      maxPrice,
      availability = '',
      sort = 'newest',
      page = 1,
      limit = 9,
    } = req.query;

    const query = { status: 'Approved' };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
      ];
    }

    if (category && category !== 'All') query.category = category;
    if (rentalType && rentalType !== 'All') query.rentalType = rentalType;

    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }

    if (availability === 'available') {
      query.quantity = { $gt: 0 };
    } else if (availability === 'unavailable') {
      query.quantity = { $lte: 0 };
    }

    let sortOption = { createdAt: -1 };
    if (sort === 'price_asc') sortOption = { price: 1 };
    if (sort === 'price_desc') sortOption = { price: -1 };

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, parseInt(limit));
    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      Equipment.find(query)
        .populate('owner', 'name email photo')
        .sort(sortOption)
        .skip(skip)
        .limit(limitNum),
      Equipment.countDocuments(query),
    ]);

    res.send({
      data: items,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch equipment', error: error.message });
  }
});

app.get('/equipment/:id', verifyToken, async (req, res) => {
  try {
    const item = await Equipment.findById(req.params.id).populate('owner', 'name email photo phone address');
    if (!item) return res.status(404).send({ message: 'Equipment not found' });
    res.send(item);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch equipment details' });
  }
});

app.post('/equipment', verifyToken, verifyOwner, async (req, res) => {
  try {
    const equipmentData = {
      ...req.body,
      owner: req.user.userId,
      status: 'Pending',
    };
    const newItem = await Equipment.create(equipmentData);
    res.status(201).send(newItem);
  } catch (error) {
    res.status(500).send({ message: 'Failed to add equipment', error: error.message });
  }
});

app.get('/owner/equipment', verifyToken, verifyOwner, async (req, res) => {
  try {
    const items = await Equipment.find({ owner: req.user.userId }).sort({ createdAt: -1 });
    res.send(items);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch your equipment' });
  }
});

app.get('/admin/equipment', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const items = await Equipment.find()
      .populate('owner', 'name email')
      .sort({ createdAt: -1 });
    res.send(items);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch all equipment' });
  }
});

app.patch('/equipment/status/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body; // 'Approved' or 'Rejected'
    const updated = await Equipment.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    res.send(updated);
  } catch (error) {
    res.status(500).send({ message: 'Failed to update equipment status' });
  }
});

app.patch('/equipment/:id', verifyToken, async (req, res) => {
  try {
    const item = await Equipment.findById(req.params.id);
    if (!item) return res.status(404).send({ message: 'Equipment not found' });

    const isOwner = item.owner.toString() === req.user.userId;
    if (!isOwner && req.user.role !== 'Admin') {
      return res.status(403).send({ message: 'Forbidden access' });
    }

    const updated = await Equipment.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.send(updated);
  } catch (error) {
    res.status(500).send({ message: 'Failed to update equipment' });
  }
});

app.delete('/equipment/:id', verifyToken, async (req, res) => {
  try {
    const item = await Equipment.findById(req.params.id);
    if (!item) return res.status(404).send({ message: 'Equipment not found' });

    const isOwner = item.owner.toString() === req.user.userId;
    if (!isOwner && req.user.role !== 'Admin') {
      return res.status(403).send({ message: 'Forbidden access' });
    }

    await Equipment.findByIdAndDelete(req.params.id);
    res.send({ success: true, message: 'Equipment deleted successfully' });
  } catch (error) {
    res.status(500).send({ message: 'Failed to delete equipment' });
  }
});

// ================= FAVORITES ROUTES =================

app.get('/favorites', verifyToken, verifyRenter, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).populate('favorites');
    res.send(user?.favorites || []);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch favorites' });
  }
});

app.post('/favorites/:equipmentId', verifyToken, verifyRenter, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $addToSet: { favorites: req.params.equipmentId } },
      { new: true }
    ).populate('favorites');
    res.send(user.favorites);
  } catch (error) {
    res.status(500).send({ message: 'Failed to add to favorites' });
  }
});

app.delete('/favorites/:equipmentId', verifyToken, verifyRenter, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $pull: { favorites: req.params.equipmentId } },
      { new: true }
    ).populate('favorites');
    res.send(user.favorites);
  } catch (error) {
    res.status(500).send({ message: 'Failed to remove from favorites' });
  }
});

// ================= BOOKINGS & STRIPE PAYMENT ROUTES =================

const calculateTotalAmount = (price, rentalType, startDate, endDate, quantity) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = Math.max(1, end - start);
  const days = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  let units = days;
  if (rentalType === 'Weekly') units = Math.ceil(days / 7);
  if (rentalType === 'Monthly') units = Math.ceil(days / 30);

  return Math.max(1, units) * price * quantity;
};

app.post('/bookings/checkout', verifyToken, verifyRenter, async (req, res) => {
  try {
    const { equipmentId, startDate, endDate, quantity, contactNumber, address, notes } = req.body;

    const equipment = await Equipment.findById(equipmentId);
    if (!equipment || equipment.status !== 'Approved') {
      return res.status(404).send({ message: 'Equipment not available' });
    }
    if (equipment.quantity < quantity) {
      return res.status(400).send({ message: `Only ${equipment.quantity} unit(s) available` });
    }

    const totalAmount = calculateTotalAmount(
      equipment.price,
      equipment.rentalType,
      startDate,
      endDate,
      Number(quantity)
    );

    const booking = await Booking.create({
      equipment: equipment._id,
      customer: req.user.userId,
      owner: equipment.owner,
      startDate,
      endDate,
      quantity: Number(quantity),
      contactNumber,
      address,
      notes,
      totalAmount,
      paymentStatus: 'Pending',
      bookingStatus: 'Pending',
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.user.email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: equipment.name,
              description: `${equipment.rentalType} Rental (${quantity} unit)`,
              images: equipment.image?.startsWith('http') ? [equipment.image] : [],
            },
            unit_amount: Math.round(totalAmount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookingId: booking._id.toString(),
        equipmentId: equipment._id.toString(),
        customerId: req.user.userId.toString(),
      },
      success_url: `${clientUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/equipment/${equipment._id}?canceled=true`,
    });

    res.send({ url: session.url, bookingId: booking._id });
  } catch (error) {
    console.error('❌ Stripe Checkout Error:', error.message);
    res.status(500).send({ message: error.message || 'Checkout failed' });
  }
});

app.post('/payments/confirm', verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(400).send({ message: 'Payment not completed yet' });
    }

    const { bookingId, equipmentId, customerId } = session.metadata;
    const transactionId = session.payment_intent || session.id;

    const existingPayment = await Payment.findOne({ transactionId });
    if (existingPayment) {
      const booking = await Booking.findById(bookingId).populate('equipment', 'name image');
      return res.send({ success: true, payment: existingPayment, booking });
    }

    const booking = await Booking.findByIdAndUpdate(
      bookingId,
      { paymentStatus: 'Paid', bookingStatus: 'Confirmed' },
      { new: true }
    ).populate('equipment', 'name image');

    if (booking) {
      await Equipment.findByIdAndUpdate(equipmentId, {
        $inc: { quantity: -booking.quantity },
      });
    }

    const payment = await Payment.create({
      bookingId,
      transactionId,
      amount: session.amount_total / 100,
      customer: customerId,
    });

    res.send({ success: true, payment, booking });
  } catch (error) {
    res.status(500).send({ message: 'Payment confirmation failed', error: error.message });
  }
});

app.get('/bookings/customer', verifyToken, verifyRenter, async (req, res) => {
  try {
    const bookings = await Booking.find({ customer: req.user.userId })
      .populate('equipment', 'name image price rentalType')
      .sort({ createdAt: -1 });
    res.send(bookings);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch customer rentals' });
  }
});

app.get('/bookings/owner', verifyToken, verifyOwner, async (req, res) => {
  try {
    const bookings = await Booking.find({ owner: req.user.userId })
      .populate('equipment', 'name image price rentalType')
      .populate('customer', 'name email phone')
      .sort({ createdAt: -1 });
    res.send(bookings);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch owner rentals' });
  }
});

app.get('/bookings/admin', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const bookings = await Booking.find()
      .populate('equipment', 'name image price rentalType')
      .populate('customer', 'name email phone')
      .populate('owner', 'name email')
      .sort({ createdAt: -1 });
    res.send(bookings);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch all rentals' });
  }
});

app.patch('/bookings/status/:id', verifyToken, async (req, res) => {
  try {
    const { bookingStatus } = req.body;
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).send({ message: 'Booking not found' });

    const isOwner = booking.owner.toString() === req.user.userId;
    if (!isOwner && req.user.role !== 'Admin') {
      return res.status(403).send({ message: 'Forbidden access' });
    }

    booking.bookingStatus = bookingStatus;
    await booking.save();
    res.send(booking);
  } catch (error) {
    res.status(500).send({ message: 'Failed to update booking status' });
  }
});

// ================= ANALYTICS ROUTES =================

app.get('/analytics/admin', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [
      totalUsers,
      totalEquipment,
      pendingApprovals,
      totalBookings,
      completedRentals,
      revenueResult,
      monthlyBookings,
    ] = await Promise.all([
      User.countDocuments(),
      Equipment.countDocuments(),
      Equipment.countDocuments({ status: 'Pending' }),
      Booking.countDocuments(),
      Booking.countDocuments({ bookingStatus: 'Completed' }),
      Payment.aggregate([
        { $group: { _id: null, totalRevenue: { $sum: '$amount' } } },
      ]),
      Booking.aggregate([
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
            },
            bookings: { $sum: 1 },
            revenue: { $sum: '$totalAmount' },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formattedMonthlyStats = monthlyBookings.map((item) => ({
      month: `${monthNames[item._id.month - 1]} ${item._id.year}`,
      bookings: item.bookings,
      revenue: item.revenue,
    }));

    res.send({
      totalUsers,
      totalEquipment,
      pendingApprovals,
      totalBookings,
      completedRentals,
      totalRevenue: revenueResult[0]?.totalRevenue || 0,
      monthlyStats: formattedMonthlyStats,
    });
  } catch (error) {
    res.status(500).send({ message: 'Failed to load admin analytics', error: error.message });
  }
});

app.get('/analytics/owner', verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerObjectId = new mongoose.Types.ObjectId(req.user.userId);

    const [
      totalListedEquipment,
      completedRentals,
      earningsResult,
      monthlyEarnings,
    ] = await Promise.all([
      Equipment.countDocuments({ owner: ownerObjectId }),
      Booking.countDocuments({ owner: ownerObjectId, bookingStatus: 'Completed' }),
      Booking.aggregate([
        { $match: { owner: ownerObjectId, paymentStatus: 'Paid' } },
        { $group: { _id: null, totalEarnings: { $sum: '$totalAmount' } } },
      ]),
      Booking.aggregate([
        { $match: { owner: ownerObjectId, paymentStatus: 'Paid' } },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
            },
            earnings: { $sum: '$totalAmount' },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formattedMonthlyEarnings = monthlyEarnings.map((item) => ({
      month: `${monthNames[item._id.month - 1]} ${item._id.year}`,
      earnings: item.earnings,
      bookings: item.bookings,
    }));

    res.send({
      totalListedEquipment,
      completedRentals,
      totalEarnings: earningsResult[0]?.totalEarnings || 0,
      monthlyEarnings: formattedMonthlyEarnings,
    });
  } catch (error) {
    res.status(500).send({ message: 'Failed to load owner analytics', error: error.message });
  }
});

// Default Route
app.get('/', (req, res) => res.send('Equipment Rental Server is Running...'));

if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
}

module.exports = app;