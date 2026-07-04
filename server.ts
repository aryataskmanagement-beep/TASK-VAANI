import './src/env.ts';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { Resend } from 'resend';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import cookieParser from 'cookie-parser';
import admin from 'firebase-admin';
import cors from 'cors';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import { readFileSync, existsSync } from 'fs';

dotenv.config();

const firebaseConfigPath = path.join(process.cwd(), 'firebase-applet-config.json');

let verifiedDbId: string | undefined | null = null; // null = unverified, undefined = default, string = custom
let configProjectId: string | undefined;
let configDatabaseId: string | undefined;
let lastReportedErrorMsg = '';
let isInitialized = false;
let saEmail = 'Unknown';
let initPromise: Promise<void> | null = null;

// Robust config loader
function loadFirebaseConfigSync() {
  if (existsSync(firebaseConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(firebaseConfigPath, 'utf-8'));
      configProjectId = config.projectId;
      configDatabaseId = config.firestoreDatabaseId;
      if (configProjectId) {
        process.env.GOOGLE_CLOUD_PROJECT = configProjectId;
        process.env.GCLOUD_PROJECT = configProjectId;
      }
      return config;
    } catch (e: any) {
      console.warn('[FIREBASE] Sync config load failed:', e.message);
    }
  }
  return null;
}

loadFirebaseConfigSync();

async function initializeFirebase() {
  if (isInitialized) return;
  if (initPromise) return initPromise;

  const config = loadFirebaseConfigSync();
  if (!config) {
    console.log('[FIREBASE] No config file found. Waiting for user setup...');
    isInitialized = true;
    return;
  }

  const targetProj = configProjectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  
  // Diagnostic: Try to get SA email once
  const saFetch = async () => {
    try {
      const saRes = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email', {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(3000)
      });
      if (saRes.ok) {
        saEmail = (await saRes.text()).trim();
        console.log(`[FIREBASE] Detectado Service Account: ${saEmail}`);
      } else {
        console.log(`[FIREBASE] Metadata status error: ${saRes.status}`);
      }
    } catch (saErr: any) {
      console.warn('[FIREBASE] Metadata fetch failed (local/non-gcp?):', saErr.message);
    }
  };

  // Initialize immediately
  try {
    if (admin.apps.length > 0) {
      const app = admin.app();
      if (app.options.projectId !== targetProj) {
        console.log(`[FIREBASE] Project mismatch. Re-initializing ${app.options.projectId} -> ${targetProj}`);
        await Promise.all(admin.apps.map(a => a?.delete()));
        admin.initializeApp({
          projectId: targetProj,
          credential: admin.credential.applicationDefault()
        });
      }
    } else {
      console.log('[FIREBASE] Initializing Admin SDK with Project:', targetProj);
      admin.initializeApp({
        projectId: targetProj,
        credential: admin.credential.applicationDefault()
      });
    }
    
    saFetch(); // First check

    console.log(`[FIREBASE] Admin SDK Initialized for Project: ${targetProj}`);
  } catch (err: any) {
    console.error('[FIREBASE] Initialization Error:', err.message);
  }


    // Database Probing - Increased retries and better logging
  initPromise = (async () => {
    try {
      const app = admin.app();
      const maxRetries = 40; // ~8 minutes
      const retryDelay = 12000;

      console.log(`[FIREBASE] Starting Database Probe for Project: ${app.options.projectId}`);
      console.log(`[FIREBASE] Current Identity: "${saEmail || 'Checking metadata...'}"`);
      
      let customFailedCount = 0;
      let defaultFailedCount = 0;
      
      for (let i = 0; i < maxRetries; i++) {
        const customId = (configDatabaseId && configDatabaseId !== '(default)') ? configDatabaseId : undefined;
        
        // Strategy: Try BOTH. Often (default) works when custom doesn't due to IAM propagation delays.
        const idsToTry = [customId, undefined].filter((v, i, a) => a.indexOf(v) === i);
        
        for (const tid of idsToTry) {
          const label = tid || '(default)';
          try {
            const dbInstance = tid ? getFirestore(app, tid) : getFirestore(app);
            // Verify access by trying to read a config doc
            await dbInstance.collection('appConfig').doc('system').get();
            
            verifiedDbId = tid;
            console.log(`[FIREBASE] SUCCESS: Database "${label}" is FULLY ACCESSIBLE by identity "${saEmail || 'application-default'}".`);
            isInitialized = true;
            lastReportedErrorMsg = ''; 
            return;
          } catch (err: any) {
            const msg = err.message || '';
            const code = err.code || -1;
            const isPermissionError = msg.includes('permission denied') || msg.includes('PERMISSION_DENIED') || code === 7;
            
            if (tid === customId && isPermissionError) customFailedCount++;
            if (tid === undefined && isPermissionError) defaultFailedCount++;
            
            const diagMsg = `PERMISSION_DENIED for DB "${label}" in Project "${app.options.projectId}". Identity: "${saEmail || 'Internal Sandbox'}". Error: ${msg}`;

            if (tid === customId || !lastReportedErrorMsg) {
              lastReportedErrorMsg = isPermissionError ? diagMsg : msg;
            }

            if (i % 5 === 0 || isPermissionError) {
              console.log(`[FIREBASE] [Probe ${i}] ${label}: ${isPermissionError ? 'AUTH_DENIED' : msg.substring(0, 70)}`);
            }
          }
        }
        
        // Background identity check refresh
        if (!saEmail || saEmail === 'Unknown') saFetch();
        
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
      
      isInitialized = true;
      if (!lastReportedErrorMsg) lastReportedErrorMsg = 'Probing timeout. No accessible database found after 8 minutes.';
      console.log('[FIREBASE] Probing completed with no verified connection.');
    } catch (fatalErr: any) {
      console.error('[FIREBASE] Fatal background init error:', fatalErr.message);
      lastReportedErrorMsg = fatalErr.message;
      isInitialized = true;
    }
  })();

  return;
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (null as any);

const genAI = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || "", 
  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } 
});

/**
 * Robust database getter that uses the verified database ID
 */
async function getDb(waitIfInitializing = true) {
  if (!isInitialized && waitIfInitializing) {
    if (initPromise) {
      // Give initial probe a chance but don't block forever
      await Promise.race([
        initPromise,
        new Promise(r => setTimeout(r, 4000))
      ]);
    } else {
      await initializeFirebase();
    }
  }
  
  const app = admin.app();
  
  // 1. If we successfully verified one during probing, use it.
  if (verifiedDbId !== null) {
    return verifiedDbId ? getFirestore(app, verifiedDbId) : getFirestore(app);
  }

  // 2. If no success yet, we have to guess. 
  // Custom ID often fails with permission issues on Gen-Lang projects initially.
  // We'll try the custom ID, but if it's likely failing, we'd want the user to know.
  if (configDatabaseId) {
    return getFirestore(app, configDatabaseId);
  }
  return getFirestore(app);
}

// Google OAuth setup
const getOAuth2Client = (req?: express.Request) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  
  // Derive redirect URI dynamically
  let derivedRedirectUri = 'http://localhost:3000/api/auth/google/callback';
  if (req) {
    const host = req.get('host');
    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const derivedAppUrl = `${protocol}://${host}`;
    const appUrl = process.env.APP_URL || derivedAppUrl;
    derivedRedirectUri = `${appUrl}/api/auth/google/callback`;
  } else if (process.env.APP_URL) {
    derivedRedirectUri = `${process.env.APP_URL}/api/auth/google/callback`;
  }
  
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || derivedRedirectUri;

  if (!clientId || !clientSecret) {
    return null;
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

async function startServer() {
  console.log('[SERVER] Starting specialized full-stack server...');
  const app = express();
  const PORT = 3000;

  // Global logging for API requests
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      console.log(`[API] ${req.method} ${req.path}`);
    }
    next();
  });

  // Re-configure CORS for robustness
  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());

  // Initialize Firebase in background
  console.log('[FIREBASE] Triggering background initialization...');
  initializeFirebase().catch(err => console.error('[FIREBASE] Startup Init Error:', err));

  // Firebase Status Check
  // Firebase Status Check
  app.get('/api/firebase/status', async (req, res) => {
    console.log('[FIREBASE_STATUS] Check requested');
    try {
      const proj = admin.apps.length > 0 ? admin.app().options.projectId : (configProjectId || 'not_configured');
      const dbId = verifiedDbId !== null ? (verifiedDbId || '(default)') : (configDatabaseId || '(default)');
      const consoleUrl = `https://console.firebase.google.com/project/${proj}/firestore/databases/${dbId}/data`;
      
      console.log(`[FIREBASE_STATUS] Returning status: ${isInitialized ? 'connected' : 'initializing'} for project ${proj}`);
      
      if (!isInitialized) {
        return res.json({
          status: 'initializing',
          project: proj,
          database: dbId,
          consoleUrl,
          isInitialized: false,
          saEmail,
          error: lastReportedErrorMsg || 'Google Cloud is currently verifying your connection...'
        });
      }

      res.json({
        status: 'connected',
        project: proj,
        database: verifiedDbId !== null ? (verifiedDbId || '(default)') : dbId,
        consoleUrl,
        isInitialized: true,
        saEmail
      });
    } catch (err: any) {
      console.error('[FIREBASE_STATUS] Critical Error:', err.message);
      res.json({
        status: 'disconnected',
        project: configProjectId || 'unknown',
        isInitialized: false,
        error: err.message || 'Server check failed',
        saEmail
      });
    }
  });

  // Helper to parse CSV data into string[][] matrices
  function parseCSV(csvText: string): string[][] {
    const lines: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;
    
    for (let i = 0; i < csvText.length; i++) {
      const char = csvText[i];
      const nextChar = csvText[i + 1];
      
      if (inQuotes) {
        if (char === '"') {
          if (nextChar === '"') {
            cell += '"';
            i++; // Skip next quote
          } else {
            inQuotes = false;
          }
        } else {
          cell += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === ',') {
          row.push(cell);
          cell = '';
        } else if (char === '\n' || char === '\r') {
          if (char === '\r' && nextChar === '\n') {
            i++; // Skip \n
          }
          row.push(cell);
          lines.push(row);
          row = [];
          cell = '';
        } else {
          cell += char;
        }
      }
    }
    if (cell !== '' || row.length > 0) {
      row.push(cell);
      lines.push(row);
    }
    return lines;
  }

  // Robustly extract Google Spreadsheet ID from any potential string format (ID or full URL)
  function extractSpreadsheetId(input: string): string {
    if (!input) return '';
    let trimmed = input.trim();
    
    // 1. Check for published web spreadsheet pattern (/spreadsheets/d/e/...) first!
    const pubMatch = trimmed.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/);
    if (pubMatch && pubMatch[1]) {
      return pubMatch[1];
    }
    
    // 2. Check for standard spreadsheet url pattern: spreadsheets/d/([a-zA-Z0-9-_]+)
    // Avoid matching 'e' if there is a next path segment
    const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (idMatch && idMatch[1]) {
      if (idMatch[1] === 'e') {
        const parts = trimmed.split('/spreadsheets/d/e/');
        if (parts.length > 1) {
          const subId = parts[1].split('/')[0].split('?')[0];
          if (subId) return subId;
        }
      } else {
        return idMatch[1];
      }
    }
    
    // Remove query parameters
    if (trimmed.includes('?')) {
      trimmed = trimmed.split('?')[0];
    }
    // Remove trailing slashes or subpaths
    if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      const lastSegment = parts.filter(Boolean).pop();
      if (lastSegment && lastSegment.length > 20) {
        return lastSegment;
      }
    }
    
    return trimmed;
  }

  // Fetch tabs of a public sheet using htmlview parsing (fully server-to-server)
  async function fetchPublicSheetTabs(sheetId: string): Promise<{ name: string, gid: string }[]> {
    try {
      const url = `https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`;
      const res = await fetch(url);
      if (!res.ok) return [];
      
      const htmlText = await res.text();
      // Match tabs like href="#gid=186411545" ...>Team Master</a>
      const regex = /href="[^"]*#gid=([0-9]+)"[^>]*>([^<]+)</gi;
      const tabs: { name: string, gid: string }[] = [];
      let match;
      while ((match = regex.exec(htmlText)) !== null) {
        const gid = match[1];
        const name = match[2].trim();
        if (name && !tabs.some(t => t.gid === gid)) {
          tabs.push({ name, gid });
        }
      }
      return tabs;
    } catch (err: any) {
      console.warn('[SYNC/UNIFIED] Failed to parse public sheets from htmlview:', err.message);
      return [];
    }
  }

  // Classify search terms to match correct Sheet types
  function classifySheet(sheetName: string, values: any[][]) : 'BUSINESS' | 'TEAM' | 'UNKNOWN' {
    const headers = ((values && values[0]) || []).map((h: any) => String(h || '').trim().toLowerCase());
    const nameLower = String(sheetName || '').toLowerCase();

    let businessScore = 0;
    let teamScore = 0;

    // Score by name
    if (nameLower.includes('business') || nameLower.includes('firm') || nameLower.includes('party') || nameLower.includes('client') || nameLower.includes('customer') || nameLower.includes('master')) {
      businessScore += 3;
    }
    if (nameLower.includes('team') || nameLower.includes('staff') || nameLower.includes('member') || nameLower.includes('employee') || nameLower.includes('sub-user') || nameLower.includes('subuser')) {
      teamScore += 3;
    }

    // Score by column elements
    headers.forEach(h => {
      // Direct exact mappings
      if (h === 'business name' || h === 'firm name' || h === 'party name' || h === 'client name' || h === 'company name' || h === 'contact person' || h === 'business code' || h === 'client code' || h === 'party code' || h === 'tan' || h === 'pan' || h === 'gst' || h === 'aadhar' || h === 'aadhaar') {
        businessScore += 3;
      }
      if (h === 'member name' || h === 'sub-user name' || h === 'sub user name' || h === 'sub-user contact' || h === 'main role' || h === 'sub role' || h === 'mainrole' || h === 'subrole') {
        teamScore += 3;
      }

      // Indirect substring mappings
      if (h.includes('business') || h.includes('firm') || h.includes('party') || h.includes('client')) {
        businessScore += 1;
      }
      if (h.includes('member') || h.includes('staff') || h.includes('sub-user') || h.includes('subuser')) {
        teamScore += 1;
      }
    });

    if (businessScore > teamScore && businessScore > 0) return 'BUSINESS';
    if (teamScore > businessScore && teamScore > 0) return 'TEAM';
    return 'UNKNOWN';
  }

  // Purely clean up faulty documents (such as Business name being saved as team member, or phone numbers being saved as names)
  async function cleanupFaultyTeamMembers(): Promise<number> {
    try {
      const db = await getDb();
      const businessesCol = db.collection('businesses');
      const teamCol = db.collection('teamMembers');

      const businessesSnapshot = await businessesCol.get();
      const teamSnapshot = await teamCol.get();

      const businessNames = new Set<string>();
      const businessContacts = new Set<string>();
      const businessEmployeeContacts = new Set<string>();

      businessesSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.name) businessNames.add(String(data.name).trim().toUpperCase());
        if (data.contact) businessContacts.add(String(data.contact).trim());
        if (data.employeeContact) businessEmployeeContacts.add(String(data.employeeContact).trim());
      });

      let deletedCount = 0;
      for (const doc of teamSnapshot.docs) {
        const data = doc.data();
        const rawName = String(data.name || '').trim();
        const rawContact = String(data.contact || '').trim();
        const upperName = rawName.toUpperCase();

        let shouldDelete = false;

        // 1. If name looks like numeric phone
        if (/^\+?[0-9\s\-]+$/.test(rawName) && rawName.length >= 8) {
          shouldDelete = true;
        }
        // 2. If name is a known business name
        else if (businessNames.has(upperName)) {
          shouldDelete = true;
        }
        // 3. If empty
        else if (!rawName) {
          shouldDelete = true;
        }
        // 4. Header templates
        else if (upperName === 'EMPLOYEE NAME' || upperName === 'EMPLOYEE CONTACT' || upperName === 'CONTACT' || upperName === 'MEMBER NAME') {
          shouldDelete = true;
        }

        if (shouldDelete) {
          console.log(`[CLEANUP] Purging corrupted team member document: [ID: ${doc.id}, Name: ${rawName}]`);
          await teamCol.doc(doc.id).delete();
          deletedCount++;
        }
      }
      return deletedCount;
    } catch (err: any) {
      console.warn('[CLEANUP] Cleanup faulty team members run failed:', err.message);
      return 0;
    }
  }

  // Unified Google Sheet Importing and Sync Engine
  async function performUnifiedSheetSync(sheetId: string, req: express.Request, res: express.Response) {
    const oauth2Client = getOAuth2Client(req);
    let tokens = null;
    let isOAuthMode = false;
    let sheetNames: string[] = [];
    let fetchedSheetsMap: Record<string, any[][]> = {};
    let oauthSuccess = false;

    if (oauth2Client) {
      try {
        tokens = await getTokens(req, res);
        if (tokens) {
          oauth2Client.setCredentials(tokens);
          const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
          const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
          sheetNames = meta.data.sheets?.map(s => s.properties?.title || '') || [];
          isOAuthMode = true;
          
          for (const sName of sheetNames) {
            try {
              const response = await sheets.spreadsheets.values.get({
                spreadsheetId: sheetId,
                range: `'${sName}'!A1:Z500`,
              });
              const val = response.data.values;
              if (val && val.length > 0) {
                fetchedSheetsMap[sName] = val;
              }
            } catch (sheetErr: any) {
              console.warn(`[SYNC/UNIFIED] Failed to read sheet "${sName}" via OAuth:`, sheetErr.message);
            }
          }
          if (Object.keys(fetchedSheetsMap).length > 0) {
            oauthSuccess = true;
            console.log(`[SYNC/UNIFIED] Successfully fetched ${Object.keys(fetchedSheetsMap).length} sheets via Google OAuth.`);
          }
        }
      } catch (err: any) {
        console.warn('[SYNC/UNIFIED] Google Auth token flow didn\'t succeed or was skipped:', err.message);
      }
    }

    // Fallback to Public direct CSV fetch if OAuth was not successful
    if (!oauthSuccess) {
      console.log('[SYNC/UNIFIED] Triggering resilient Public/Non-Auth Direct Fetch...');
      try {
        const tabs = await fetchPublicSheetTabs(sheetId);
        const isPublished = sheetId.startsWith('2PACX-');
        
        if (tabs && tabs.length > 0) {
          console.log(`[SYNC/UNIFIED] HTMLView parse found ${tabs.length} tabs:`, tabs.map(t => t.name));
          for (const tab of tabs) {
            try {
              const csvUrl = isPublished
                ? `https://docs.google.com/spreadsheets/d/e/${sheetId}/pub?output=csv&gid=${tab.gid}`
                : `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${tab.gid}`;
              
              const csvRes = await fetch(csvUrl);
              if (csvRes.ok) {
                const csvText = await csvRes.text();
                const values = parseCSV(csvText);
                if (values && values.length > 0) {
                  fetchedSheetsMap[tab.name] = values;
                }
              }
            } catch (err: any) {
              console.warn(`[SYNC/UNIFIED] Public fetch failed for tab "${tab.name}":`, err.message);
            }
          }
        }

        // Standard fallback if sheet list was totally empty
        if (Object.keys(fetchedSheetsMap).length === 0) {
          console.log('[SYNC/UNIFIED] Public Fallback: Fetching first sheet via default CSV endpoint');
          const defaultUrl = isPublished
            ? `https://docs.google.com/spreadsheets/d/e/${sheetId}/pub?output=csv`
            : `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
          
          const defaultRes = await fetch(defaultUrl);
          if (defaultRes.ok) {
            const csvText = await defaultRes.text();
            const values = parseCSV(csvText);
            if (values && values.length > 0) {
              fetchedSheetsMap['Sheet1'] = values;
            }
          } else {
            const gvizUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
            const gvizRes = await fetch(gvizUrl);
            if (gvizRes.ok) {
              const csvText = await gvizRes.text();
              const values = parseCSV(csvText);
              if (values && values.length > 0) {
                fetchedSheetsMap['Sheet1'] = values;
              }
            }
          }
        }

        // Try explicitly reading Team sheet by matching popular tab names if not yet fetched
        const alreadyHasTeam = Object.keys(fetchedSheetsMap).some(name => classifySheet(name, fetchedSheetsMap[name]) === 'TEAM');
        if (!alreadyHasTeam) {
          const teamTabNames = ["Team Master", "TEAM MASTER", "Team Master Detail", "Team", "TEAM"];
          for (const tName of teamTabNames) {
            try {
              const csvUrl = isPublished
                ? `https://docs.google.com/spreadsheets/d/e/${sheetId}/pub?output=csv&sheet=${encodeURIComponent(tName)}`
                : `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tName)}`;
              
              const res2 = await fetch(csvUrl);
              if (res2.ok) {
                const text2 = await res2.text();
                const values = parseCSV(text2);
                if (values && values.length >= 2) {
                  fetchedSheetsMap[tName] = values;
                  console.log(`[SYNC/UNIFIED] Found team sheet via public name fallback: "${tName}"`);
                  break;
                }
              }
            } catch (err) {}
          }
        }
      } catch (fallbackErr: any) {
        console.error('[SYNC/UNIFIED] Public Fallback fetching failed:', fallbackErr.message);
      }
    }

    if (Object.keys(fetchedSheetsMap).length === 0) {
      return res.status(400).json({
        error: "Google Sheets can't be fetched. Check that your Sheet's sharing matches 'Anyone with link can view' or sign in to Google Auth."
      });
    }

    // Score and identify the sheets
    let businessValues: any[][] | null = null;
    let teamValues: any[][] | null = null;
    let classifiedBusinessSheet: string | null = null;
    let classifiedTeamSheet: string | null = null;

    for (const sName of Object.keys(fetchedSheetsMap)) {
      const vals = fetchedSheetsMap[sName];
      if (vals && vals.length >= 2) {
        const typeCls = classifySheet(sName, vals);
        if (typeCls === 'BUSINESS' && !businessValues) {
          businessValues = vals;
          classifiedBusinessSheet = sName;
        } else if (typeCls === 'TEAM' && !teamValues) {
          teamValues = vals;
          classifiedTeamSheet = sName;
        }
      }
    }

    // Default fallbacks back to indices
    const sheetKeys = Object.keys(fetchedSheetsMap);
    if (!businessValues && sheetKeys.length > 0) {
      businessValues = fetchedSheetsMap[sheetKeys[0]];
      classifiedBusinessSheet = sheetKeys[0];
    }
    if (!teamValues && sheetKeys.length >= 2 && sheetKeys[0] !== sheetKeys[1]) {
      teamValues = fetchedSheetsMap[sheetKeys[1]];
      classifiedTeamSheet = sheetKeys[1];
    }

    if (!businessValues || businessValues.length < 2) {
      return res.status(400).json({
        error: "No Business Master records (with data starting at row 2) found."
      });
    }

    console.log(`[SYNC/UNIFIED] Final Sheet Assignment: BUSINESS => "${classifiedBusinessSheet}", TEAM => "${classifiedTeamSheet || 'NONE'}"`);

    // Fetch and Sync Business Master
    const bizResult = await syncBusinessesToFirestore(businessValues, !isOAuthMode);

    // Fetch and Sync Team Master
    let teamAdded = 0;
    let teamUpdated = 0;
    let teamError = undefined;

    if (teamValues) {
      try {
        const teamResult = await syncTeamMembersToFirestore(teamValues);
        teamAdded = teamResult.added;
        teamUpdated = teamResult.updated;
        teamError = teamResult.error;
      } catch (err: any) {
        console.warn('[SYNC/UNIFIED] Team Member sync failed:', err.message);
        teamError = err.message;
      }
    }

    // Execute automatic cleanup of bad/currupt data entries in team members tab
    const cleanedCount = await cleanupFaultyTeamMembers();

    return res.json({
      success: true,
      added: bizResult.added,
      updated: bizResult.updated,
      ignored: bizResult.ignored,
      teamAdded,
      teamUpdated,
      teamError,
      cleanedFaultyTeamCount: cleanedCount,
      usedSheet: classifiedBusinessSheet,
      usedTeamSheet: classifiedTeamSheet
    });
  }

  app.post('/api/google-sheets/import', async (req, res) => {
    const { sheetId: rawSheetId } = req.body;
    if (!rawSheetId) {
      return res.status(400).json({ error: 'Sheet ID must be provided' });
    }

    const sheetId = extractSpreadsheetId(rawSheetId);
    if (!sheetId) {
      return res.status(400).json({ error: 'Invalid Google Spreadsheet ID or URL format.' });
    }

    try {
      await performUnifiedSheetSync(sheetId, req, res);
    } catch (err: any) {
      console.error('[IMPORT] Unified sync failed:', err);
      res.status(500).json({ error: err.message || 'Sheet sync failed' });
    }
  });

  // Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // AI Routes
  app.post('/api/ai/classify', async (req, res) => {
    try {
      const { file, businessList } = req.body;
      
      const prompt = `You are an expert document classifier for an accounting firm "ARYA ASSOCIATES".
      Task: Identify which business from the provided list owns this document.
      
      Business List: ${JSON.stringify(businessList)}
      
      Instructions:
      1. Scan the document for the Business Name, Trade Name, or GST Number.
      2. Match it against the provided list.
      3. If you find a clear match, return ONLY the corresponding business ID.
      4. If it's an invoice TO a business in our list (expense), or FROM a business in our list (income), it belongs to our client.
      5. If no match is found or you are unsure, return "UNKNOWN".
      6. Return ONLY the string ID or "UNKNOWN" - no markdown, no explanation.`;

      const response = await genAI.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: file.mimeType,
                data: file.base64Data,
              },
            },
            { text: prompt },
          ]
        }
      });

      res.json({ result: (response.text || "UNKNOWN").trim() });
    } catch (error: any) {
      console.error('AI Classify Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/summary', async (req, res) => {
    try {
      const { logs } = req.body;
      const prompt = `Generate a professional weekly performance report for the CA office 'ARYA ASSOCIATES'. 
      Here are the task logs from the team for the past week:
      ${logs}
      
      The report should include:
      1. Overall Completion Summary.
      2. Performance of individual team members.
      3. Business-wise highlight (which clients had the most activity).
      4. Strategic advice for the next week.
      
      Format the output as clean, professional text.`;

      const response = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt
      });
      
      res.json({ result: response.text || "Summary unavailable." });
    } catch (error: any) {
      console.error('AI Summary Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/extract', async (req, res) => {
    try {
      const { file } = req.body;
      const prompt = `Extract business profile details from this document (e.g., GST Certificate, PAN Card, Letterhead, or Address Proof).
      
      Instructions for GST Certificate (REG-06):
      - Look for "Legal Name" and "Trade Name". Use the Trade Name as the primary 'name' if available, otherwise use Legal Name.
      - Extract GSTIN as 'gst'.
      - Extract PAN (usually digits 3-12 of the GSTIN) as 'pan'.
      - Extract Address of Principal Place of Business as 'address'.

      Return ONLY a JSON object with these keys:
      - name: Business or Individual Name
      - contactPerson: Contact Person Name (Proprietor/Partner/Director)
      - contact: Phone Number
      - email: Email Address
      - gst: GST Number
      - pan: PAN Number
      - address: Full Address
      
      Formatting Instructions:
      - If a field is not found, use an empty string.
      - Return ONLY the JSON object. Do not include markdown code blocks or any other text.`;

      const response = await genAI.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: file.mimeType,
                data: file.base64Data,
              },
            },
            { text: prompt },
          ]
        },
        config: {
          responseMimeType: "application/json"
        }
      });

      const text = response.text || "{}";
      res.json(JSON.parse(text));
    } catch (error: any) {
      console.error('AI Extract Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Google OAuth Routes
  app.post('/api/firebase/switch-to-default', async (req, res) => {
    try {
      if (existsSync(firebaseConfigPath)) {
        const config = JSON.parse(await fs.readFile(firebaseConfigPath, 'utf-8'));
        config.firestoreDatabaseId = "(default)";
        await fs.writeFile(firebaseConfigPath, JSON.stringify(config, null, 2));
        
        // Reset state
        isInitialized = false;
        verifiedDbId = null;
        lastReportedErrorMsg = '';
        initPromise = null;
        configDatabaseId = "(default)";
        
        initializeFirebase(); // Restart probing
        res.json({ success: true, message: "Switched to (default) database. Re-probing started." });
      } else {
        res.status(404).json({ error: "Config file not found" });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/firebase/re-probe', async (req, res) => {
    console.log('[FIREBASE] Manual re-probe triggered via API');
    isInitialized = false;
    verifiedDbId = null;
    lastReportedErrorMsg = '';
    initPromise = null;
    initializeFirebase(); // Trigger but don't block
    res.json({ success: true, message: "Verification restart sequence initiated. Wait 10-20 seconds." });
  });

  app.get('/api/auth/google/url', (req, res) => {
    const { uid } = req.query;
    const oauth2Client = getOAuth2Client(req);
    if (!oauth2Client) {
      return res.status(500).json({ 
        error: 'Google OAuth is not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in settings.' 
      });
    }

    const scope = [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ];

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope,
      prompt: 'consent',
      include_granted_scopes: true,
      state: uid as string || 'anonymous'
    });

    res.json({ url });
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    const { code, state: uid } = req.query;
    const oauth2Client = getOAuth2Client(req);

    if (!oauth2Client) {
      return res.status(500).send('Google OAuth Configuration Missing');
    }

    try {
      const { tokens } = await oauth2Client.getToken(code as string);
      
      // Store tokens in cookie 
      res.cookie('google_tokens', JSON.stringify(tokens), {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });

      // Persist to Firestore if UID provided
      if (uid && uid !== 'anonymous') {
        try {
          const db = await getDb();
          await db.collection('users').doc(uid as string).set({
            google_tokens: tokens,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`[AUTH] Tokens persisted to Firestore for user: ${uid}`);
        } catch (fiErr) {
          console.error('[AUTH] Failed to persist tokens:', fiErr);
        }
      }

      res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f8fafc; margin: 0; padding: 20px; box-sizing: border-box; }
              .card { text-align: center; padding: 2.5rem; background: white; border-radius: 1.5rem; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); max-width: 400px; width: 100%; border: 1px solid #e2e8f0; }
              .icon { font-size: 3.5rem; margin-bottom: 1rem; }
              h2 { color: #059669; margin: 0 0 0.75rem 0; font-weight: 800; font-size: 1.5rem; letter-spacing: -0.025em; }
              p { color: #64748b; font-size: 0.95rem; line-height: 1.6; margin: 0 0 2rem 0; }
              .btn { 
                display: block; width: 100%; padding: 1rem; background: #10b981; color: white; text-decoration: none; border-radius: 1rem; 
                font-weight: 700; font-size: 0.875rem; border: none; cursor: pointer; transition: transform 0.2s, background 0.2s;
              }
              .btn:active { transform: scale(0.98); background: #059669; }
              .footer { margin-top: 1.5rem; font-size: 0.75rem; color: #94a3b8; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="icon">✅</div>
              <h2>Login Successful</h2>
              <p>Your Google account has been connected. You can now use Google Sheets features in the app.</p>
              
              <button onclick="handleDone()" class="btn">Finish & Return to App</button>
              
              <div class="footer">
                If the window doesn't close, please switch back to your App tab.
              </div>

              <script>
                function handleDone() {
                  // Notify parent
                  if (window.opener) {
                    try {
                      window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS' }, '*');
                    } catch (e) {
                      console.error('Failed to notify opener:', e);
                    }
                  }
                  
                  // Try to close
                  window.close();
                  
                  // Fallback for mobile if close doesn't work or opener is null
                  setTimeout(() => {
                    // Try to redirect back - using window.location.origin is safest
                    window.location.href = window.location.origin;
                  }, 500);
                }

                // Auto-try on load
                setTimeout(handleDone, 2000);
              </script>
            </div>
          </body>
        </html>
      `);
    } catch (error: any) {
      console.error('Google Auth Callback Error:', error);
      res.status(500).send(`Authentication failed: ${error.message}`);
    }
  });

  app.get('/api/google/check-auth', async (req, res) => {
    const { uid } = req.query;
    let tokens = req.cookies.google_tokens;
    
    // Recovery from Firestore if cookie missing but UID present
    if (!tokens && uid && uid !== 'undefined') {
      try {
        const db = await getDb(false);
        // Only attempt doc read if we verified the database ID
        if (verifiedDbId !== null) {
           const doc = await db.collection('users').doc(uid as string).get();
           if (doc.exists && doc.data()?.google_tokens) {
             tokens = JSON.stringify(doc.data()?.google_tokens);
             // Restore cookie
             res.cookie('google_tokens', tokens, {
               httpOnly: true,
               secure: true,
               sameSite: 'none',
               maxAge: 30 * 24 * 60 * 60 * 1000
             });
             console.log(`[AUTH] Restored tokens from Firestore for ${uid}`);
           }
        }
      } catch (e: any) {
        // Silent fail if Firestore is blocked by Error 7 or other issues
        if (!e.message?.includes('PERMISSION_DENIED') && !e.message?.includes('permission denied')) {
           console.error('[AUTH] Background check failed:', e.message);
        }
      }
    }

    const isConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    res.json({ authenticated: !!tokens, configured: isConfigured });
  });

  app.get('/api/check-configs', (req, res) => {
    res.json({
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      resend: !!process.env.RESEND_API_KEY,
      webhookSecret: !!(process.env.SHEETS_WEBHOOK_SECRET && process.env.SHEETS_WEBHOOK_SECRET !== 'NOT_SET_IN_ENV')
    });
  });

  app.post('/api/google/logout', async (req, res) => {
    const { uid } = req.body;
    res.clearCookie('google_tokens', {
      httpOnly: true,
      secure: true,
      sameSite: 'none'
    });

    if (uid) {
      try {
        const db = await getDb();
        await db.collection('users').doc(uid).update({
          google_tokens: admin.firestore.FieldValue.delete()
        });
      } catch (e) {
        console.warn('[AUTH] Firestore token cleanup failed:', e);
      }
    }

    res.json({ success: true });
  });

  const getTokens = async (req: express.Request, res?: express.Response) => {
    let tokensStr = req.cookies.google_tokens;
    const { uid } = (req.method === 'GET' ? req.query : req.body);
    
    if (!tokensStr && uid && uid !== 'undefined' && uid !== 'anonymous') {
      try {
        // Try getting DB without waiting indefinitely
        const db = await getDb(false);
        const doc = await db.collection('users').doc(uid as string).get();
        if (doc.exists && doc.data()?.google_tokens) {
          tokensStr = JSON.stringify(doc.data()?.google_tokens);
          if (res) {
            res.cookie('google_tokens', tokensStr, {
              httpOnly: true,
              secure: true,
              sameSite: 'none',
              maxAge: 30 * 24 * 60 * 60 * 1000
            });
          }
          console.log(`[AUTH] Restored tokens from Firestore for ${uid} during API call`);
        }
      } catch (e: any) {
        // Log but don't throw - if we have no cookie and no Firestore access, 
        // the calling function will handle the null return.
        if (!e.message?.includes('PERMISSION_DENIED')) {
           console.error('[AUTH] Token recovery failed:', e.message);
        }
      }
    }
    return tokensStr ? JSON.parse(tokensStr) : null;
  };

  const clearInvalidTokens = async (req: express.Request, res?: express.Response, explicitUid?: string) => {
    if (res) {
      res.clearCookie('google_tokens', {
        httpOnly: true,
        secure: true,
        sameSite: 'none'
      });
    }
    let finalUid = explicitUid;
    if (!finalUid) {
      const { uid } = (req.method === 'GET' ? req.query : req.body);
      finalUid = uid as string;
    }
    if (finalUid && finalUid !== 'undefined' && finalUid !== 'anonymous') {
      try {
        const db = await getDb(false);
        await db.collection('users').doc(finalUid).update({
          google_tokens: admin.firestore.FieldValue.delete()
        });
        console.log(`[AUTH] Cleared invalid/expired Google tokens from Firestore for user ${finalUid}`);
      } catch (cleanErr: any) {
        console.warn(`[AUTH] Token cleanup in Firestore failed:`, cleanErr.message);
      }
    }
  };

  const handleGoogleError = async (error: any, req: express.Request, res: express.Response, routeName: string) => {
    console.error(`[${routeName}] Google API Error encountered:`, error.message || error);
    let originalMsg = error.message || String(error);
    const hasInvalidGrant = originalMsg.includes('invalid_grant') || 
                            originalMsg.includes('credentials_invalid') ||
                            originalMsg.includes('invalid_credentials') ||
                            (error.response?.data?.error === 'invalid_grant') ||
                            (error.response?.data?.error_description?.includes('invalid_grant'));

    if (hasInvalidGrant) {
      // Clear token to allow subsequent login attempts to be clean
      await clearInvalidTokens(req, res);
      const friendlyMsg = "❌ Your Google Auth Session has expired or been revoked (invalid_grant). Actions Required: Please go to the App's 'Settings' (⚙️ Icon) page, click 'Sign in with Google' under Google Workspace Sync to refresh your connection, and try again.";
      return res.status(401).json({ error: friendlyMsg });
    }

    let detailMsg = originalMsg;
    if (error.response?.data?.error?.message) {
      detailMsg = error.response.data.error.message;
    }

    if (error.code === 404) {
      detailMsg = `Spreadsheet not found or ID is invalid. Verify your sheet URL/ID.`;
    } else if (error.code === 403) {
      detailMsg = `Permission Denied. Make sure your Google Account has owner or editor access to this spreadsheet.`;
    }

    const finalStatusCode = error.code && error.code >= 100 && error.code < 600 ? error.code : 500;
    return res.status(finalStatusCode).json({ error: detailMsg });
  };

  // Google Sheets Export
  app.post('/api/google/sheets/sync', async (req, res) => {
    const { sheetName, data, spreadsheetId } = req.body;
    const oauth2Client = getOAuth2Client(req);

    if (!oauth2Client) {
      return res.status(500).json({ error: 'Google API Credentials missing in settings.' });
    }

    try {
      const tokens = await getTokens(req, res);
      if (!tokens) {
        return res.status(401).json({ error: 'Not authenticated with Google. Please click "Enable Google-Integration" again.' });
      }
      oauth2Client.setCredentials(tokens);

      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
      const drive = google.drive({ version: 'v3', auth: oauth2Client });

      let targetSpreadsheetId = spreadsheetId;

      // 1. Verify if the provided spreadsheetId actually exists and is not in trash
      if (targetSpreadsheetId) {
        try {
          console.log(`Checking existing spreadsheet: ${targetSpreadsheetId}`);
          const check = await drive.files.get({ 
            fileId: targetSpreadsheetId, 
            fields: 'id, trashed, name' 
          });
          if (check.data.trashed) {
            console.log('Spreadsheet is in trash, will find or create a new one');
            targetSpreadsheetId = null;
          }
        } catch (err: any) {
          console.warn('SpreadsheetId is invalid or inaccessible, will find or create a new one');
          targetSpreadsheetId = null;
        }
      }

      // 2. Search for existing ARYA_CENTRAL_LOG if we don't have a valid ID
      if (!targetSpreadsheetId) {
        console.log('Searching for ARYA_CENTRAL_LOG spreadsheet...');
        try {
          const files = await drive.files.list({
            q: "name = 'ARYA_CENTRAL_LOG' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
            fields: 'files(id, name)',
            pageSize: 1
          });

          if (files.data.files && files.data.files.length > 0) {
            targetSpreadsheetId = files.data.files[0].id;
            console.log(`Found existing spreadsheet: ${targetSpreadsheetId}`);
          } else {
            // 3. Create new spreadsheet if not found
            console.log('Creating new ARYA_CENTRAL_LOG spreadsheet...');
            const spreadsheet = await sheets.spreadsheets.create({
              requestBody: {
                properties: { title: 'ARYA_CENTRAL_LOG' },
              },
            });
            targetSpreadsheetId = spreadsheet.data.spreadsheetId;
            console.log(`Created new spreadsheet with ID: ${targetSpreadsheetId}`);
          }
        } catch (err: any) {
          console.error('Search/Create Error:', err);
          if (err.message.includes('Google Sheets API has not been used') || err.message.includes('Google Drive API has not been used')) {
            throw new Error('Google APIs are not enabled. Please enable Sheets and Drive APIs in Google Cloud Console.');
          }
          throw err;
        }
      }

      if (!targetSpreadsheetId) {
        throw new Error('Failed to identify or create a target spreadsheet.');
      }

      const currentSheetName = (sheetName || 'Sheet1').trim();
      // Ensure we use single quotes for range if name contains spaces
      const quotedSheetName = currentSheetName.includes(' ') ? `'${currentSheetName}'` : currentSheetName;
      
      let existingRows: any[][] = [];
      try {
        const spreadsheet = await sheets.spreadsheets.get({
          spreadsheetId: targetSpreadsheetId
        });
        const sheetExists = spreadsheet.data.sheets?.some(s => s.properties?.title === currentSheetName);
        
        if (!sheetExists) {
          console.log(`Creating sheet: ${currentSheetName}`);
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: targetSpreadsheetId,
            requestBody: {
              requests: [
                {
                  addSheet: {
                    properties: { title: currentSheetName }
                  }
                }
              ]
            }
          });
        } else {
          console.log(`Fetching existing data from: ${quotedSheetName}!A:Z`);
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId: targetSpreadsheetId,
            range: `${quotedSheetName}!A:Z`,
          });
          existingRows = response.data.values || [];
        }
      } catch (err) {
        console.warn('Could not verify/create sheet or fetch data:', err);
      }

      // Logic: Upsert - Update if identity (Col 0,1,2) matches, Append if new
      const updateRequests: any[] = [];
      const appendRows: any[][] = [];
      let updatedCount = 0;

      data.forEach((incomingRow: any[]) => {
        // Find index of matching row in existing data
        const existingIdx = existingRows.findIndex(exRow => 
          exRow[0] === incomingRow[0] && // Timestamp
          exRow[1] === incomingRow[1] && // Business
          exRow[2] === incomingRow[2]    // Task
        );

        if (existingIdx !== -1) {
          // Overwrite the existing row as requested, even if content is same
          updateRequests.push({
            range: `${quotedSheetName}!A${existingIdx + 1}`,
            values: [incomingRow]
          });
          updatedCount++;
        } else {
          appendRows.push(incomingRow);
        }
      });

      // Execute updates in batch
      if (updateRequests.length > 0) {
        console.log(`Executing ${updateRequests.length} updates in ${quotedSheetName}`);
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: targetSpreadsheetId,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: updateRequests
          }
        });
      }

      // Execute appends
      if (appendRows.length > 0) {
        console.log(`Appending ${appendRows.length} rows to ${quotedSheetName}`);
        await sheets.spreadsheets.values.append({
          spreadsheetId: targetSpreadsheetId,
          range: `${quotedSheetName}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: appendRows,
          },
        });
      }

      res.json({ 
        success: true, 
        spreadsheetId: targetSpreadsheetId, 
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${targetSpreadsheetId}`,
        addedCount: appendRows.length,
        updatedCount: updatedCount
      });
    } catch (error: any) {
      console.error('Sheets Sync Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Google Sheets Import
  app.get('/api/google/sheets/read', async (req, res) => {
    const { spreadsheetId, range } = req.query;
    const oauth2Client = getOAuth2Client(req);

    if (!oauth2Client) return res.status(500).json({ error: 'OAuth not configured' });
    
    try {
      const tokens = await getTokens(req, res);
      if (!tokens) return res.status(401).json({ error: 'Google Auth required' });
      if (!spreadsheetId) return res.status(400).json({ error: 'Spreadsheet ID required' });

      oauth2Client.setCredentials(tokens);
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId as string,
        range: (range as string) || 'Sheet1!A:Z',
      });

      res.json({ success: true, values: response.data.values || [] });
    } catch (error: any) {
      console.error('Sheets Read Error:', error);
      let message = error.message;
      if (error.code === 404) {
        message = `Spreadsheet not found. Please verify the Spreadsheet ID: ${spreadsheetId}`;
      } else if (error.message && error.message.includes('range')) {
        message = `Sheet name or range not found: ${range}. Please check if the sheet name in your Google Sheet matches.`;
      }
      let statusCode = 500;
      if (typeof error.code === 'number' && error.code >= 100 && error.code < 600) {
        statusCode = error.code;
      }
      res.status(statusCode).json({ error: message });
    }
  });

  // Manual Sync Business Master from Google Sheet
  app.get('/api/google/sheets/fetch-businesses', async (req, res) => {
    try {
      const { spreadsheetId, range, uid } = req.query;
      if (!spreadsheetId) return res.status(400).json({ error: "Spreadsheet ID is required" });
      
      const tokens = await getTokens(req, res);
      if (!tokens) return res.status(401).json({ error: "Google Auth required. Please connect your account first." });

      const oauth2Client = getOAuth2Client(req);
      if (!oauth2Client) return res.status(500).json({ error: "Google Client not configured." });

      oauth2Client.setCredentials(tokens);
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId as string,
        range: (range as string) || 'Sheet1!A:Z',
      });

      const values = response.data.values;
      if (!values || values.length < 2) {
        return res.status(400).json({ error: "No data found in the specified range." });
      }

      // Basic mapping - iterate and find best matches
      const rawHeaders = values[0].map(h => String(h || '').trim());
      const headers = rawHeaders.map(h => h.toLowerCase());
      
      const nameIdx = headers.findIndex(h => h.includes('name') || h.includes('business') || h.includes('client') || h.includes('party') || h.includes('firm'));
      const codeIdx = headers.findIndex(h => h.includes('code') || h.includes('id') || h.includes('sr') || h.includes('tin') || h.includes('sl') || h.includes('no'));
      
      const data = values.slice(1).map((row, i) => {
        const biz: any = {
          id: `local-${Date.now()}-${i}`,
          lastSynced: new Date().toISOString()
        };
        
        // Map headers to fields
        headers.forEach((h, j) => {
          if (!row[j]) return;
          const val = String(row[j]).trim();
          if (!val) return;

          const flatKey = h.replace(/[^a-z0-9]/g, '');

          if (h.includes('name') || h.includes('business') || h.includes('party') || h.includes('firm')) biz.name = val;
          else if (h.includes('code') || h.includes('id') || h.includes('sr') || h.includes('sl') || h.includes('no')) biz.businessCode = val;
          else if (h.includes('contact') || h.includes('phone') || h.includes('mobile')) biz.contact = val;
          else if (h.includes('person')) biz.contactPerson = val;
          else if (h.includes('member') || h.includes('assigned') || h.includes('team') || h.includes('handler')) biz.teamMember = val;
          else if (h.includes('status')) biz.firmStatus = val;
          else if (h.includes('pan')) biz.pan = val;
          else if (h.includes('tan')) biz.tan = val;
          else if (h.includes('gst')) biz.gstin = val;
          else if (h.includes('email')) biz.email = val;
          else if (h.includes('address')) biz.address = val;
          else if (h.includes('pass')) biz.password = val;
          
          // Also store as raw flat key
          if (flatKey && !biz[flatKey]) biz[flatKey] = val;
        });

        // Fallbacks
        if (!biz.name) biz.name = (nameIdx !== -1 ? row[nameIdx] : row[0]) || "Unknown Business";
        if (!biz.businessCode) biz.businessCode = (codeIdx !== -1 ? row[codeIdx] : `L${i+1}`);
        
        return biz;
      });

      res.json({ success: true, count: data.length, businesses: data });
    } catch (err: any) {
      console.error('[FETCH] Local sync failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/google/sheets/sync-businesses', async (req, res) => {
    const { spreadsheetId: rawId, range } = req.body;

    const spreadsheetId = extractSpreadsheetId(rawId || '');
    if (!spreadsheetId) {
      return res.status(400).json({ error: 'Spreadsheet ID or URL could not be identified' });
    }

    try {
      await performUnifiedSheetSync(spreadsheetId, req, res);
    } catch (error: any) {
      console.error('[SYNC_BUSINESSES] Unified manual sync error:', error);
      res.status(500).json({ error: error.message || 'Sheet sync failed' });
    }
  });

  app.get('/api/google/sheets/test-connection', async (req, res) => {
    const { spreadsheetId } = req.query;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });
    
    try {
      const oauth2Client = getOAuth2Client(req);
      if (!oauth2Client) return res.status(500).json({ error: 'Google OAuth not configured' });
      
      const tokens = await getTokens(req, res);
      if (!tokens) return res.status(401).json({ error: 'User is not logged into Google' });
      
      oauth2Client.setCredentials(tokens);
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
      
      const meta = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId as string });
      res.json({ 
        success: true, 
        title: meta.data.properties?.title,
        sheets: meta.data.sheets?.map(s => s.properties?.title)
      });
    } catch (error: any) {
      return handleGoogleError(error, req, res, 'SHEET_TEST');
    }
  });

  // Google Sheets Auto-Sync Webhook (Called by Apps Script)
  app.post('/api/google/sheets/webhook', async (req, res) => {
    const { secret, spreadsheetId, sheetName, data: rawData } = req.body;
    
    try {
      // Security check - load secret from env or firestore
      const db = await getDb();
      const currentProj = admin.apps.length > 0 ? admin.app().options.projectId : (configProjectId || 'unknown');
      
      console.log(`Checking webhook secret in DB [${verifiedDbId !== null ? (verifiedDbId || '(default)') : (configDatabaseId || '(default)')}] (Project: ${currentProj})...`);
      let expectedSecret = process.env.SHEETS_WEBHOOK_SECRET;
      if (!expectedSecret || expectedSecret === 'NOT_SET_IN_ENV') {
        const doc = await db.collection('appConfig').doc('system').get();
        if (doc.exists) {
          expectedSecret = doc.data()?.webhookSecret;
        }
      }

      if (!secret || secret !== expectedSecret) {
        return res.status(403).json({ error: 'Unauthorized webhook call' });
      }

      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Missing spreadsheetId' });
      }

      // If data is provided in body, use it. Otherwise, fetch from sheet.
      let values = rawData;
      
      if (!values) {
        // We'd need a service account or stored refresh token to fetch in background without a user session.
        // For now, assume Google Apps Script sends the data directly.
        return res.status(400).json({ error: 'Webhook expects data payload' });
      }

      // Detect if we should sync to teamMembers or businesses
      const headers = (values[0] || []).map((h: any) => String(h || '').trim().toLowerCase());
      const isTeamSheet = headers.includes('member name') || headers.includes('sub-user name') || headers.includes('linked sub-user') ||
                           (sheetName && String(sheetName).toLowerCase().includes('team')) ||
                           (sheetName && String(sheetName).toLowerCase().includes('member'));
      
      let result;
      let syncType = 'BUSINESS';
      if (isTeamSheet) {
        result = await syncTeamMembersToFirestore(values);
        syncType = 'TEAM_MEMBER';
      } else {
        result = await syncBusinessesToFirestore(values);
      }
      
      // Log for debugging
      try {
        await db.collection('logs').add({
          type: 'WEBHOOK_SYNC',
          syncType,
          spreadsheetId,
          sheetName: sheetName || 'unknown',
          added: result.added,
          updated: result.updated,
          timestamp: FieldValue.serverTimestamp(),
          source: 'Google Apps Script'
        });
      } catch (logErr) {
        console.warn('Failed to log webhook event:', logErr);
      }

      res.json({ success: true, syncType, ...result });
    } catch (error: any) {
      console.error('Webhook Sync Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/google/sheets/webhook-info', async (req, res) => {
    try {
      const db = await getDb();
      const currentProj = admin.apps.length > 0 ? admin.app().options.projectId : (configProjectId || 'unknown');
      
      console.log(`Fetching webhook info from DB [${verifiedDbId !== null ? (verifiedDbId || '(default)') : (configDatabaseId || '(default)')}] (Project: ${currentProj})...`);
      let secret = process.env.SHEETS_WEBHOOK_SECRET;
      
      // Fallback to Firestore if Env var is missing
      if (!secret || secret === 'NOT_SET_IN_ENV') {
        const doc = await db.collection('appConfig').doc('system').get();
        if (doc.exists) {
          secret = doc.data()?.webhookSecret;
        }
      }

      const host = req.get('host');
      const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
      const derivedAppUrl = `${protocol}://${host}`;
      const appUrl = process.env.APP_URL || derivedAppUrl;
      
      res.json({ 
        url: `${appUrl}/api/google/sheets/webhook`,
        secret: secret || 'NOT_SET_YET'
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });  // Internal helper to sync business data to Firestore
  async function syncBusinessesToFirestore(values: any[][], isFallback = false): Promise<{ added: number, updated: number, ignored: number, error?: string }> {
    if (!values || values.length < 2) {
      console.warn('[SYNC] Received empty or single-row data');
      return { added: 0, updated: 0, ignored: 0 };
    }
    
    try {
      const db = await getDb();
      const app = admin.app();
      const currentProj = app.options.projectId || configProjectId || 'GEN_LANG_CLIENT';
      const dbIdStr = verifiedDbId !== null ? (verifiedDbId || '(default)') : (configDatabaseId || '(default)');
      
      console.log(`[SYNC] Starting sync to Project: ${currentProj}, DB: ${dbIdStr}${isFallback ? ' (FALLBACK MODE)' : ''}`);
      
      // Connection & Permission Check
      const businessesCol = db.collection('businesses');
      try {
        // High-level probe to check if the identity can see the collection
        await businessesCol.limit(1).get();
      } catch (checkErr: any) {
        console.warn(`[SYNC] Connection check FAILED for DB [${dbIdStr}]:`, checkErr.message);
        
        const lowerMsg = (checkErr.message || '').toLowerCase();
        const isPermission = lowerMsg.includes('permission denied') || lowerMsg.includes('permission_denied') || checkErr.code === 7;
        const isNotFound = lowerMsg.includes('not found') || lowerMsg.includes('not_found') || checkErr.code === 5;
        
        if (isPermission) {
          if (!initPromise) initializeFirebase();
          throw new Error(`PERMISSION_DENIED for DB "${dbIdStr}". 
            Fix Steps:
            1. Go to IAM: https://console.cloud.google.com/iam-admin/iam?project=${currentProj}
            2. Grant "Cloud Datastore User" to identity: "${saEmail || 'Internal Sandbox'}".
            3. Verify Native Mode: https://console.cloud.google.com/firestore/databases/-default-/configuration?project=${currentProj}
            4. If using custom DB ID "${dbIdStr}", ensure it exists or switch to "(default)" in app settings.
            Details: ${checkErr.message}`);
        }
        
        if (isNotFound) {
          throw new Error(`Database "${dbIdStr}" not found. If your project uses the standard database, try switching to "(default)" in Settings sync panel.`);
        }

        throw new Error(`Cloud Sync Suspended (${checkErr.message}). Current Project in Config: ${currentProj}. Service Account: ${saEmail}.`);
      }

      const rawHeaders = values[0].map(h => String(h || '').trim());
      const headers = rawHeaders.map(h => h.toLowerCase());
      const dataRows = values.slice(1);
      
      // Find Business Name column with high precision
      const isHeaderCodeOrId = (h: string) => h.includes('code') || h.includes('id') || h.includes('serial') || h.includes('sr') || h.includes('sl') || h.includes('no') || h.includes('num') || h.includes('contact') || h.includes('mobile') || h.includes('phone') || h.includes('pass');

      let nameIdx = headers.findIndex(h => (h === 'business name' || h === 'firm name' || h === 'party name' || h === 'client name' || h === 'company name' || h === 'party' || h === 'business') && !isHeaderCodeOrId(h));
      if (nameIdx === -1) {
        nameIdx = headers.findIndex(h => h.includes('name') && !h.includes('employee') && !h.includes('employe') && !h.includes('empolyee') && !h.includes('emp') && !isHeaderCodeOrId(h));
      }
      if (nameIdx === -1) {
        nameIdx = headers.findIndex(h => (h.includes('business') || h.includes('client') || h.includes('party') || h.includes('firm')) && !isHeaderCodeOrId(h));
      }
      if (nameIdx === -1) {
        nameIdx = headers.findIndex(h => h.includes('name') && !isHeaderCodeOrId(h));
      }
      // Index 1 (Column B) is the default if mapping is ambiguous
      if (nameIdx === -1 && headers.length > 1) {
        nameIdx = 1;
      }
      
      // Find Business Code column with high precision
      let codeIdx = headers.findIndex(h => h === 'business code' || h === 'client code' || h === 'party code');
      if (codeIdx === -1) {
        codeIdx = headers.findIndex(h => h.includes('code') && !h.includes('employee') && !h.includes('employe') && !h.includes('empolyee') && !h.includes('emp'));
      }
      if (codeIdx === -1) {
        codeIdx = headers.findIndex(h => h.includes('id') || h.includes('sr') || h.includes('sl') || h.includes('no'));
      }
      
      if (nameIdx === -1) {
        return { 
          added: 0, 
          updated: 0, 
          ignored: 0,
          error: `Sheet mapping failed. Could not find a "Name" column. Detected headers: [${rawHeaders.join(', ')}]. Please use "Business Name" or "Party Name".` 
        };
      }

      console.log(`[SYNC] Header Mapping: nameIdx=${nameIdx}, codeIdx=${codeIdx}`);
      
      let added = 0;
      let updated = 0;
      let ignored = 0;
      let failCount = 0;
      const errors: string[] = [];
      
      for (let index = 0; index < dataRows.length; index++) {
        const row = dataRows[index];
        if (!row || row.length === 0 || row.every(cell => !cell)) {
          ignored++;
          continue;
        }
        
        const biz: any = {};
        headers.forEach((hRaw, i) => {
          if (hRaw && row[i] !== undefined) {
            const h = String(hRaw).toLowerCase().trim();
            const val = String(row[i]).trim();
            if (!val) return;

            const isCodeOrId = h.includes('code') || h.includes('id') || h.includes('serial') || h.includes('sr') || h.includes('sl') || h.includes('no') || h.includes('num');

            // 1. Employee-specific exact or substring mapping (highest priority to prevent employee details merging into party fields)
            if (h.includes('employee name') || h.includes('employe name') || h.includes('empolyee name') || h.includes('emp name')) {
              biz.employeeName = val;
            } else if (h.includes('employee contact') || h.includes('employe contact') || h.includes('empolyee contact') || h.includes('emp contact') || h.includes('employee mobile') || h.includes('employe mobile')) {
              biz.employeeContact = val;
            } else if (h.includes('employee password') || h.includes('employe password') || h.includes('empolyee password') || h.includes('emp password') || h.includes('emp pass')) {
              biz.employeePassword = val;
            }
            
            // 2. Strict Exact Matches for Party fields
            else if (h === 'business code' || h === 'client code' || h === 'party code' || h === 'party serial' || h === 'serial number') biz.businessCode = val;
            else if (h === 'business name' || h === 'firm name' || h === 'party name' || h === 'client name' || h === 'company name' || h === 'party' || h === 'business') biz.name = val;
            else if (h === 'contact person') biz.contactPerson = val;
            else if (h === 'contact person dob') biz.contactPersonDOB = val;
            else if (h === 'pan') biz.pan = val;
            else if (h === 'gst' || h === 'gstin') biz.gst = val;
            else if (h === 'tan') biz.tan = val;
            else if (h === 'vat') biz.vat = val;
            else if (h === 'aadhar' || h === 'aadhaar') biz.aadhar = val;
            else if (h === 'dob-firm' || h === 'dob' || h === 'dob firm' || h === 'date of birth') biz.dob = val;
            else if (h === 'contact number' || h === 'mobile' || h === 'phone' || h === 'contact' || h === 'contact no') biz.contact = val;
            else if (h === 'group icon' || h === 'whatsapp group' || h === 'whatsapp group icon' || h === 'whatsapp group link' || h === 'group') biz.whatsappGroup = val;
            else if (h === 'assigned to' || h === 'team member' || h === 'assigned') biz.teamMember = val;
            else if (h === 'firm status' || h === 'status') biz.firmStatus = val;
            else if (h === 'login password' || h === 'password' || h === 'pass') biz.password = val;

            // 3. Substring variations fallback (excluding fields that can cross-map and keeping it clean)
            else if ((h.includes('contact person dob') || h.includes('person dob')) && !isCodeOrId) biz.contactPersonDOB = biz.contactPersonDOB || val;
            else if (h.includes('contact person') && !isCodeOrId) biz.contactPerson = biz.contactPerson || val;
            else if (h.includes('whatsapp') || h.includes('group')) biz.whatsappGroup = biz.whatsappGroup || val;
            else if (h.includes('contact number') || h.includes('mobile') || h.includes('phone') || h === 'contact') biz.contact = biz.contact || val;
            else if ((h.includes('assigned to') || h.includes('assigned') || h.includes('team member')) && !isCodeOrId) biz.teamMember = biz.teamMember || val;
            else if ((h.includes('firm status') || h.includes('status')) && !isCodeOrId) biz.firmStatus = biz.firmStatus || val;
            else if (h.includes('login password') || h.includes('password') || h === 'pass') biz.password = biz.password || val;
            else if (h.includes('dob') && !isCodeOrId) biz.dob = biz.dob || val;
            else if (h.includes('code') || h === 'id') biz.businessCode = biz.businessCode || val;
            // Prevent names that are codes/ids etc
            else if ((h.includes('name') || h.includes('client') || h.includes('party') || h.includes('firm')) && !isCodeOrId) biz.name = biz.name || val;
            
            // Generic capture for anything else to avoid losing custom columns
            const sanitizedKey = h.replace(/[^a-z0-9]/g, '');
            if (sanitizedKey && !biz[sanitizedKey] && !isCodeOrId && !sanitizedKey.includes('code')) biz[sanitizedKey] = val;
          }
        });
        
        // Final fallback for required fields
        if (!biz.name && row[nameIdx]) biz.name = String(row[nameIdx]).trim();
        
        if (!biz.name) {
          ignored++;
          continue;
        }

        if (!biz.businessCode) {
          if (codeIdx !== -1 && row[codeIdx]) {
            biz.businessCode = String(row[codeIdx]).trim();
          } else {
            // Stable deterministic code based on name to work across row reordering
            const cleanNameDigit = biz.name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10).toUpperCase();
            biz.businessCode = 'GEN-' + (cleanNameDigit || 'BIZ') + '-' + biz.name.length;
          }
        }

        try {
          // Match existing database entries:
          // 1. Match by stable incoming businessCode
          let matchFound = false;
          let docId = '';
          let existingData: any = null;
          
          if (biz.businessCode && biz.businessCode !== '') {
            const queryByCode = await businessesCol.where('businessCode', '==', biz.businessCode).limit(1).get();
            if (!queryByCode.empty) {
              matchFound = true;
              docId = queryByCode.docs[0].id;
              existingData = queryByCode.docs[0].data();
            }
          }
          
          // 2. Fallback: Match by exact party/business name
          if (!matchFound && biz.name) {
            const queryByName = await businessesCol.where('name', '==', biz.name).limit(1).get();
            if (!queryByName.empty) {
              matchFound = true;
              docId = queryByName.docs[0].id;
              existingData = queryByName.docs[0].data();
            }
          }
          
          if (matchFound) {
            // Keep the real/manually specified business code if the sheet code is auto-generated but DB has a real one
            if (biz.businessCode.startsWith('GEN-') && existingData && existingData.businessCode && !existingData.businessCode.startsWith('GEN-')) {
              biz.businessCode = existingData.businessCode;
            }
            
            await businessesCol.doc(docId).update({
              ...biz,
              updatedAt: FieldValue.serverTimestamp()
            });
            updated++;
          } else {
            await businessesCol.add({
              ...biz,
              id: `c${Date.now()}${index}`,
              createdAt: FieldValue.serverTimestamp()
            });
            added++;
          }
        } catch (opErr: any) {
          failCount++;
          const errMsg = opErr.message || String(opErr);
          if (failCount < 5) errors.push(`Row ${index + 2}: ${errMsg}`);
          console.error(`[SYNC] Row ${index + 2} failed:`, errMsg);
          
          if (errMsg.includes('PERMISSION_DENIED')) {
             throw new Error(`Permission Denied on Project ${currentProj} (DB: ${dbIdStr}). This usually means the server's service account lacks "Cloud Datastore User" or "Editor" roles on this project. Please ensure Firebase setup was successful.`);
          }
        }
      }
      
      return { added, updated, ignored, error: errors.length > 0 ? errors.join('; ') : undefined };
    } catch (err: any) {
      console.error('[SYNC] Fatal Sync Error:', err);
      const proj = admin.apps.length > 0 ? admin.app().options.projectId : 'unknown';
      const dbId = verifiedDbId !== null ? (verifiedDbId || '(default)') : (configDatabaseId || '(default)');
      if (err.message && err.message.includes('PERMISSION_DENIED')) {
        throw new Error(`Firestore Permission Denied. Project: ${proj}, DB: ${dbId}. Access has likely not been granted to the server's service account. Details: ${err.message}`);
      }
      throw err;
    }
  }

  // Internal helper to sync team member data to Firestore
  async function syncTeamMembersToFirestore(values: any[][]): Promise<{ added: number, updated: number, ignored: number, error?: string }> {
    if (!values || values.length < 2) {
      console.warn('[SYNC/TEAM] Received empty or single-row data');
      return { added: 0, updated: 0, ignored: 0 };
    }
    
    try {
      const db = await getDb();
      const teamCol = db.collection('teamMembers');
      
      const rawHeaders = values[0].map(h => String(h || '').trim());
      const headers = rawHeaders.map(h => h.toLowerCase());
      const dataRows = values.slice(1);
      
      const nameIdx = headers.findIndex(h => (h.includes('name') || h.includes('member') || h === 'employee' || h === 'team member') && !h.includes('contact') && !h.includes('mobile') && !h.includes('phone') && !h.includes('number') && !h.includes('pass'));
      if (nameIdx === -1) {
        return { 
          added: 0, 
          updated: 0, 
          ignored: 0,
          error: `Team sheet mapping failed. Could not find a "Name" or "Member Name" column. Detected headers: [${rawHeaders.join(', ')}].` 
        };
      }
      
      let added = 0;
      let updated = 0;
      let ignored = 0;
      let failCount = 0;
      const errors: string[] = [];
      
      for (let index = 0; index < dataRows.length; index++) {
        const row = dataRows[index];
        if (!row || row.length === 0 || row.every(cell => !cell)) {
          ignored++;
          continue;
        }
        
        const member: any = {
          mainRole: 'MAIN',
          subRole: 'SUB'
        };
        
        headers.forEach((hRaw, i) => {
          if (hRaw && row[i] !== undefined) {
            const h = String(hRaw).toLowerCase().trim();
            const val = String(row[i]).trim();
            if (!val) return;
            
            if (h === 'member name' || h === 'name' || h.includes('employee name') || h.includes('employe name') || h.includes('empolyee name') || h === 'team member' || h === 'team member name' || (h.includes('employee') && h.includes('name')) || (h.includes('member') && !h.includes('contact') && !h.includes('mobile') && !h.includes('phone') && !h.includes('number'))) {
              member.name = val;
            } else if (h === 'contact' || h === 'contact number' || h.includes('mobile') || h.includes('phone') || h.includes('contact mobile') || h === 'employee contact' || h === 'employee mobile' || h === 'employe mobile') {
              member.contact = val;
            } else if (h === 'sub-user name' || h === 'sub user name' || h.includes('subusername') || h.includes('linked sub')) {
              member.subUserName = val;
            } else if (h === 'sub-user contact' || h === 'sub-user mobile' || h === 'sub user contact' || h.includes('subusercontact')) {
              member.subUserContact = val;
            } else if (h.includes('role') || h === 'mainrole' || h === 'main role') {
              member.mainRole = (val.toUpperCase() === 'SUB') ? 'SUB' : 'MAIN';
            } else if (h === 'subrole' || h === 'sub role') {
              member.subRole = (val.toUpperCase() === 'MAIN') ? 'MAIN' : 'SUB';
            }
          }
        });
        
        if (!member.name && row[nameIdx]) {
          member.name = String(row[nameIdx]).trim();
        }
        
        if (!member.name) {
          ignored++;
          continue;
        }
        
        try {
          // Check for existing team member by name
          const query = await teamCol.where('name', '==', member.name).limit(1).get();
          
          if (query.empty) {
            const docId = `t${Date.now()}${(Math.floor(Math.random() * 90) + 10)}${index}`;
            await teamCol.doc(docId).set({
              ...member,
              id: docId,
              createdAt: FieldValue.serverTimestamp()
            });
            added++;
          } else {
            const docId = query.docs[0].id;
            await teamCol.doc(docId).update({
              ...member,
              updatedAt: FieldValue.serverTimestamp()
            });
            updated++;
          }
        } catch (opErr: any) {
          failCount++;
          const errMsg = opErr.message || String(opErr);
          if (failCount < 5) errors.push(`Team Row ${index + 2}: ${errMsg}`);
          console.error(`[SYNC/TEAM] Row ${index + 2} failed:`, errMsg);
        }
      }
      
      return { added, updated, ignored, error: errors.length > 0 ? errors.join('; ') : undefined };
    } catch (err: any) {
      console.error('[SYNC/TEAM] Fatal Sync Error:', err);
      return { added: 0, updated: 0, ignored: 0, error: err.message };
    }
  }

  // Google Drive File Upload (PDF/Excel)
  app.post('/api/google/drive/upload', async (req, res) => {
    const { fileName, content, mimeType, folderName } = req.body;
    const oauth2Client = getOAuth2Client(req);

    if (!oauth2Client) {
      return res.status(500).json({ error: 'Google API Credentials missing in settings.' });
    }

    try {
      const tokens = await getTokens(req, res);
      if (!tokens) {
        return res.status(401).json({ error: 'Not authenticated with Google.' });
      }
      oauth2Client.setCredentials(tokens);

      const drive = google.drive({ version: 'v3', auth: oauth2Client });

      let folderId;
      if (folderName) {
        try {
          const folders = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
            fields: 'files(id, name)',
          });

          if (folders.data.files && folders.data.files.length > 0) {
            folderId = folders.data.files[0].id;
          } else {
            const folder = await drive.files.create({
              requestBody: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
              },
              fields: 'id',
            });
            folderId = folder.data.id;
          }
        } catch (err: any) {
          if (err.message.includes('Google Drive API has not been used')) {
            throw new Error('Google Drive API is not enabled in your Google Cloud Project. Please enable it in the Google Cloud Console.');
          }
          throw err;
        }
      }

      const buffer = Buffer.from(content, 'base64');
      const { Readable } = await import('stream');
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);

      const file = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: folderId ? [folderId] : [],
        },
        media: {
          mimeType,
          body: stream,
        },
        fields: 'id, webViewLink',
      });

      res.json({ success: true, fileId: file.data.id, fileUrl: file.data.webViewLink });
    } catch (error: any) {
      console.error('Drive Upload Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Email Sending Route
  app.post('/api/send-report', async (req, res) => {
    const { to, subject, body, attachments } = req.body;
    
    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({ error: 'Resend API Key is missing. Please set RESEND_API_KEY in the application settings.' });
    }

    try {
      const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
      
      const { data, error } = await resend.emails.send({
        from: `ARYA ASSOCIATES <${fromEmail}>`,
        to: [to],
        subject,
        text: body,
        attachments: (attachments || []).map((att: any) => ({
          filename: att.filename,
          content: att.content,
        })),
      });

      if (error) {
        console.error('Resend Error:', error);
        return res.status(400).json({ error: error.message });
      }

      res.json({ success: true, data });
    } catch (error: any) {
      console.error('Email Send Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Guest Link Route
  app.post('/api/send-guest-link', async (req, res) => {
    const { email, name, token } = req.body;
    
    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({ error: 'Resend API Key is missing.' });
    }

    try {
      const host = req.get('host');
      const protocol = req.protocol;
      const derivedAppUrl = `${protocol}://${host}`;
      const appUrl = process.env.APP_URL || derivedAppUrl;
      const guestLink = `${appUrl}/?guest_token=${token}&guest_email=${encodeURIComponent(email)}`;
      const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
      
      // Generate a simple 6-digit code from the token (for mobile ease)
      const guestCode = token.substring(0, 6).toUpperCase();

      const { data, error } = await resend.emails.send({
        from: `ARYA ASSOCIATES <${fromEmail}>`,
        to: [email],
        subject: 'Access Code - ARYA ASSOCIATES',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
            <h2 style="color: #4f46e5; text-align: center;">Access Link & Code</h2>
            <p>Hello <strong>${name}</strong>,</p>
            <p>Use the link or the code below to access the ARYA ASSOCIATES portal.</p>
            
            <div style="margin: 30px 0; text-align: center;">
              <p style="font-size: 12px; color: #64748b; margin-bottom: 8px;">Option 1: Click the button</p>
              <a href="${guestLink}" style="display: inline-block; background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; margin-bottom: 20px;">Verify & Access Portal</a>
              
              <div style="background-color: #f8fafc; padding: 20px; border-radius: 12px; border: 1px dashed #cbd5e1; margin-top: 20px;">
                <p style="font-size: 12px; color: #64748b; margin-bottom: 8px;">Option 2: Enter this code in the app</p>
                <div style="font-size: 32px; font-weight: 900; color: #1e293b; letter-spacing: 10px; margin: 10px 0;">${guestCode}</div>
              </div>
            </div>
            
            <p style="font-size: 14px; color: #64748b;">If you didn't request this, you can safely ignore this email.</p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
            <p style="font-size: 12px; color: #94a3b8; text-align: center;">This is an automated message for mobile users. Please do not reply.</p>
          </div>
        `,
      });

      if (error) {
        console.error('Resend Guest Error:', error);
        return res.status(400).json({ error: error.message });
      }

      res.json({ success: true, data, debugLink: guestLink, debugCode: guestCode });
    } catch (error: any) {
      console.error('Guest Link Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Global Error Handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled Error:', err);
    if (req.path.startsWith('/api/')) {
       return res.status(500).json({ 
         error: 'Internal Server Error', 
         details: err.message,
         path: req.path
       });
    }
    next(err);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Default to Client-Side (SPA) behavior
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      // Check if file exists, if not serve index.html (SPA fallback)
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`[FIREBASE] Serving for Project: ${configProjectId || 'unknown'}`);
    console.log(`[FIREBASE] Active DB ID: ${verifiedDbId !== null ? (verifiedDbId || '(default)') : (configDatabaseId || '(default)')}`);
  });
}

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
