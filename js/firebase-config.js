// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"
import { getAnalytics } 
from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
export const firebaseConfig = {
  apiKey: "AIzaSyCCtH8Z6RIy0rTNGlwSBpz4quv4tysmVSA",
  authDomain: "pendaftaran-anggota-52ee9.firebaseapp.com",
  projectId: "pendaftaran-anggota-52ee9",
  storageBucket: "pendaftaran-anggota-52ee9.firebasestorage.app",
  messagingSenderId: "61403400669",
  appId: "1:61403400669:web:a2b0778ff492bd3a8c0e34",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);