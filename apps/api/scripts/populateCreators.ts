// addUsers.js

import admin from 'firebase-admin';
import { initializeApp, cert } from 'firebase-admin/app';
import { readFileSync } from 'fs';

// Initialize the Firebase Admin SDK using the specified method
initializeApp({
  credential: cert(JSON.parse(readFileSync('utils/firebase-service-account.json', 'utf8'))),
});

// Array of users to be created
const usersToCreate = [
    { displayName: 'Eleanor Vance', email: 'eleanor.vance@outlook.com' },
    { displayName: 'Marcus Thorne', email: 'm.thorne78@gmail.com' },
    { displayName: 'Sofia Al-Jamil', email: 'sofia_aljamil@yahoo.com' },
    { displayName: 'Brendan O’Malley', email: 'brendan.omalley@icloud.com' },
    { displayName: 'Chloe Nguyen', email: 'cnguyen@gmail.com' },
    { displayName: 'Julian Croft', email: 'jcroft22@hotmail.com' },
    { displayName: 'Isabelle Dubois', email: 'isabelle.d@protonmail.com' },
    { displayName: 'Rajesh Patel', email: 'r.patel1985@yahoo.com' },
    { displayName: 'Samantha Kim', email: 'sammiekim@gmail.com' },
    { displayName: 'Leo Garcia', email: 'leogarcias_kitchen@outlook.com' },
    { displayName: 'Heidi Zimmerman', email: 'heidi.zimmerman91@aol.com' },
    { displayName: 'Damian Kowalski', email: 'kowalski.damian@gmail.com' },
    { displayName: 'Fiona Campbell', email: 'fionacampbell@icloud.com' },
    { displayName: 'Kenji Tanaka', email: 'kenji_tanaka@hotmail.com' },
    { displayName: 'Ava Chen', email: 'avachen8@yahoo.com' },
    { displayName: 'Franklin Shaw', email: 'frank.shaw77@gmail.com' },
    { displayName: 'Grace Holloway', email: 'graceholloway@outlook.com' },
    { displayName: 'Oscar Mendoza', email: 'o.mendoza@protonmail.com' },
    { displayName: 'Tessa Romano', email: 'tromano_art@yahoo.com' },
    { displayName: 'Simon Fletcher', email: 'simonfletcher@gmail.com' }
];


async function createFirebaseUsers() {
  console.log(`Starting to import ${usersToCreate.length} users...`);

  for (const user of usersToCreate) {
    // Generate a secure, random password for each user.
    const randomPassword = Math.random().toString(36).slice(-10);
    
    // Use a placeholder image service. This one uses the email to generate a unique avatar.
    const photoURL = `https://i.pravatar.cc/150?u=${user.email}`;

    try {
      const userRecord = await admin.auth().createUser({
        email: user.email,
        emailVerified: true,
        password: randomPassword,
        displayName: user.displayName,
        photoURL: photoURL,
        disabled: false,
      });
      console.log(`✅ Successfully created user: ${user.displayName} (UID: ${userRecord.uid})`);
    } catch (error: any) {
        
      if (error.code === 'auth/email-already-exists') {
        console.warn(`⚠️  User already exists: ${user.email}`);
      } else {
        console.error(`❌ Error creating user ${user.displayName}:`, error);
      }
    }
  }

  console.log('\nUser import process finished.');
}

// Run the function
createFirebaseUsers();