# Changelog

## v5.0.9 (2024/08/21)

### Bug Fixes
* **Client:** Fixed a problem that prevented clients from being set up properly

## v5.0.8 (2024/08/21)

### Features

* **Client:** Support for tv_embedded player to make age-restricted videos available
* **Player:** Change to use [youtube-po-token-generator](https://github.com/YunzheZJU/youtube-po-token-generator) to get poToken automatically when poToken is not specified. (For stable operation, generate manually.)
* **Log:** Improved log output

## v5.0.7 (2024/08/20)

### Features

* **Client:** Support for a variety of clients (Can be specified by `clients` argument)
```typescript
ytdl.getInfo('VIDEO_URL', {
    clients: ['C1', 'C2'],
});
```

* **Data:** Support for specifying whether to include or exclude data used in processing to prevent data growth (Default: false)
```typescript
ytdl.getInfo('VIDEO_URL', {
    includesPlayerAPIResponse: true,
    includesWatchPageInfo: true,
});
```

* **Log:** Changed to display warning if poToken is not specified

## v5.0.0 (2024/08/20)

### Features

* **Code:** Rewrote all code to TypeScript
* **Player:** poToken, and visitorData support
```typescript
ytdl.getInfo('VIDEO_URL', {
    poToken: 'PO_TOKEN',
    visitorData: 'VISITOR_DATA',
});
```
