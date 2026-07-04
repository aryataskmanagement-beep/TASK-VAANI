if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(registrations => {
      if (registrations.length > 0) {
        console.log('Stale SW found. Unregistering...');
        Promise.all(registrations.map(r => r.unregister()))
          .then(() => {
            if ('caches' in window) {
              caches.keys().then(names => {
                Promise.all(names.map(name => caches.delete(name)))
                  .then(() => {
                    console.log('Cache cleared. Reloading page...');
                    window.location.reload();
                  });
              });
            } else {
              window.location.reload();
            }
          });
      }
    })
    .catch(err => console.log('SW retrieval error!', err));
}

