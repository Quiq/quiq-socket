# Quiq-Socket

WebSocket wrapper with retry and heartbeat.
-------------------------------------------

[![styled with prettier](https://img.shields.io/badge/styled_with-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![Build Status](https://travis-ci.org/Quiq/quiq-socket.svg?branch=master)](https://travis-ci.org/Quiq/quiq-socket)

## Installation

```
npm i --save quiq-socket
```

or

```
yarn add quiq-socket
```

---

## Usage

```js
import QuiqSocket from 'quiq-socket';

new QuiqSocket()
    .withUrl('https://myapp.com/socket')
    .addEventListener('message', message => {
        console.log(message);
    });
```

---

Many methods and options are available, and are documented inline in `src/quiqSocket.js`. 

## License

MIT
