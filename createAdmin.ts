import mongoose from 'mongoose';
import { User } from './src/models/User';
import { ENV } from './src/config/env';

const createOrUpdateAdmin = async () => {
  try {
    const MONGO_URI = ENV.MONGODB_URI;
    if (!MONGO_URI) throw new Error('MongoDB URI is not defined');
    
    await mongoose.connect(MONGO_URI);
    console.log('Connected to Database');

    // CHANGE THESE VALUES TO YOUR DESIRED ADMIN CREDENTIALS
    const email = 'admin@example.com'; 
    const password = 'newpassword123'; 
    const name = 'Admin User';

    let admin = await User.findOne({ email });

    if (admin) {
      admin.password = password;
      admin.role = 'admin';
      admin.isActive = true;
      admin.isVerified = true;
      await admin.save();
      console.log(`Admin password updated successfully for ${email}`);
    } else {
      admin = new User({
        name,
        email,
        password,
        role: 'admin',
        isActive: true,
        isVerified: true
      });
      await admin.save();
      console.log(`New admin created successfully for ${email}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

createOrUpdateAdmin();
