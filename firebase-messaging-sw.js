importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAnnY_7g_026Lh_LUiIr5Ie4gZYR40y-bo",
  authDomain: "logisbj-9fab5.firebaseapp.com",
  projectId: "logisbj-9fab5",
  storageBucket: "logisbj-9fab5.firebasestorage.app",
  messagingSenderId: "595076095983",
  appId: "1:595076095983:web:bdda91c7044a113bf1201a"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('Notification reçue en arrière-plan:', payload);
  const { title, body, icon } = payload.notification;
  self.registration.showNotification(title, {
    body,
    icon: icon || '/icon-192.png',
    badge: '/icon-192.png'
  });
});
