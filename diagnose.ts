
import admin from 'firebase-admin';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

console.log('--- ENV DIAGNOSTICS ---');
let targetProj = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

if (!targetProj && fs.existsSync('firebase-applet-config.json')) {
  try {
    const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
    targetProj = config.projectId;
  } catch (err) {
    console.error('Error reading config file:', err);
  }
}

targetProj = targetProj || 'not-found';
console.log('GOOGLE_CLOUD_PROJECT:', targetProj);

async function run() {
  try {
    admin.initializeApp({
      projectId: targetProj,
      credential: admin.credential.applicationDefault()
    });
    const db = admin.firestore();
    const doc = await db.collection('appConfig').doc('system').get();
    if (doc.exists) {
      console.log('Firestore appConfig system data:', doc.data());
    } else {
      console.log('Document appConfig system does not exist in Firestore yet.');
    }
  } catch (error) {
    console.error('Error fetching system config:', error);
  }
  process.exit(0);
}

run();
