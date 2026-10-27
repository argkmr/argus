# Argus Tab Context

This local Chrome extension shares one tab at a time with Argus. It never reads tabs in the background.

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `chrome-extension` folder.
4. Pin **Argus Tab Context**.
5. Open Grafana and click the extension.
   - **Share current page** captures text already present in the page.
   - **Deep capture logs** scrolls through the largest virtualized log area, waits for each batch to render, collects it, and restores your scroll position.
6. In Argus, click **Chrome tab** in the repository or Nexus composer.

Deep capture can retrieve virtualized rows that Grafana loads while scrolling, without separate Grafana credentials. It cannot retrieve rows excluded by Grafana's server-side result limit or time-range query. Captures have a local 18 MB safety limit; narrow the time range and create multiple captures if necessary.
