const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  photo: { type: String },
  phone: { type: String, default: '' },
  address: { type: String, default: '' },
  password: { type: String },
  role: { type: String, enum: ['Customer', 'Owner', 'Admin'], default: 'Customer' },
  favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Equipment' }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);