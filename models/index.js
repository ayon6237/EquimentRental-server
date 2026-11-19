const User = require('./models/User');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Basic Middlewares
app.use(cors({
  origin: ['http://localhost:3000'], 
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected Successfully!"))
  .catch(err => console.log("❌ MongoDB Connection Error:", err));


const verifyToken = (req, res, next) => {
  const token = req.cookies?.token || req.headers?.authorization?.split(' ')[1];
  if (!token) return res.status(401).send({ message: 'Unauthorized access' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).send({ message: 'Unauthorized access' });
    req.user = decoded; 
    next();
  });
};

const verifyRenter = async (req, res, next) => {
  if (req.user.role !== 'Customer') return res.status(403).send({ message: 'Forbidden access! Customer only.' });
  next();
};

const verifyOwner = async (req, res, next) => {
  if (req.user.role !== 'Owner') return res.status(403).send({ message: 'Forbidden access! Owner only.' });
  next();
};

const verifyAdmin = async (req, res, next) => {
  if (req.user.role !== 'Admin') return res.status(403).send({ message: 'Forbidden access! Admin only.' });
  next();
};



app.post('/jwt', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    
    const payload = {
      email,
      role: user ? user.role : 'Customer',
      userId: user ? user._id : null
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
    }).send({ success: true, token });
  } catch (error) {
    res.status(500).send({ message: 'Failed to generate token', error: error.message });
  }
});



app.post('/logout', (req, res) => {
  res.clearCookie('token', {
    maxAge: 0,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
  }).send({ success: true });
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
      role: 'Customer'
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




// Default Route
app.get('/', (req, res) => res.send('Equipment Rental Server is Running...'));

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));