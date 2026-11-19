const mongoose = require('mongoose');

const equipmentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String, required: true },
  location: { type: String, required: true },
  price: { type: Number, required: true },
  rentalType: { type: String, enum: ['Daily', 'Weekly', 'Monthly'], required: true },
  quantity: { type: Number, required: true },
  condition: { type: String, required: true },
  brand: { type: String },
  model: { type: String },
  image: { type: String, required: true },
  terms: { type: String, required: true },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Equipment', equipmentSchema);