/**
 * Seeds "The Onam Collection · 2026" — the five pieces named for the flowers of
 * the season. Idempotent: upserts by product name, so it is safe to re-run.
 *
 *   npx ts-node seedOnamCollection.ts
 *
 * Images are left empty on purpose — the storefront renders a warm editorial
 * placeholder until real photography is uploaded from the admin panel.
 */
import mongoose from 'mongoose';
import { Product } from './src/models/Product';
import { ENV } from './src/config/env';

const COLLECTION = 'Onam';
const SEASON = 'Onam 2026';

const PIECES = [
  {
    name: 'Chethi',
    garmentType: 'Lace-Trim Kurta Set',
    price: 18500,
    lifeMode: 'At-Home Identity',
    description:
      'A lace-trimmed kurta set cut for still, humid afternoons — structured at the shoulder, easy through the body.',
  },
  {
    name: 'Thamara',
    garmentType: 'Floral Silk Saree',
    price: 24000,
    lifeMode: 'Occasion',
    description:
      'A floral silk saree that holds its drape through a long evening and stays quiet against the skin.',
  },
  {
    name: 'Kaitha',
    garmentType: 'Embroidered Column Dress',
    price: 16800,
    lifeMode: 'Ambition',
    description:
      'A column dress with fine embroidery — a clean vertical line built for heat, meetings and movement.',
  },
  {
    name: 'Ilanji',
    garmentType: 'Garden Drape Saree',
    price: 22500,
    lifeMode: 'Occasion',
    description:
      'A garden-drape saree, light in the hand and breathable through the weave, for gatherings that run into the rain.',
  },
  {
    name: 'Marigold',
    garmentType: 'Structured Kurta Set',
    price: 19500,
    lifeMode: 'Casual/Out',
    description:
      'A structured kurta set that keeps its shape in monsoon air — considered, unfussy, made to be worn often.',
  },
];

const run = async () => {
  try {
    const MONGO_URI = ENV.MONGODB_URI;
    if (!MONGO_URI) throw new Error('MongoDB URI is not defined');

    await mongoose.connect(MONGO_URI);
    console.log('Connected to Database');

    for (const piece of PIECES) {
      const doc = {
        name: piece.name,
        category: piece.garmentType,
        garmentType: piece.garmentType,
        description: piece.description,
        collectionName: COLLECTION,
        season: SEASON,
        lifeMode: piece.lifeMode,
        offerText: 'Onam 2026',
        showOnLandingPage: true,
        status: 'In Stock',
        images: [] as string[],
        variants: [
          {
            volume: 'Standard',
            price: piece.price,
            images: [] as string[],
          },
        ],
      };

      const existing = await Product.findOne({ name: piece.name });
      if (existing) {
        // Update merchandising fields but keep any images already uploaded.
        existing.set({
          garmentType: doc.garmentType,
          collectionName: doc.collectionName,
          season: doc.season,
          lifeMode: doc.lifeMode,
          description: doc.description,
          showOnLandingPage: true,
        });
        if (!existing.variants?.length) existing.set('variants', doc.variants);
        await existing.save();
        console.log(`Updated: ${piece.name}`);
      } else {
        await Product.create(doc);
        console.log(`Created: ${piece.name} — ₹${piece.price.toLocaleString('en-IN')}`);
      }
    }

    console.log('Onam collection seeded successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

run();
