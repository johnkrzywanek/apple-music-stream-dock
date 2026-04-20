/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

const $local = true, $back = false, $dom = {
    main: $('.sdpi-wrapper'),
    showTitle: $('#showTitle')
};

const $propEvent = {
    didReceiveGlobalSettings({ settings }) {
    },
    didReceiveSettings(data) {
        // Set initial state from saved settings (set checked BEFORE adding listener)
        $dom.showTitle.checked = data.settings?.showTitle !== false;

        // Handle show title toggle change - use sendToPlugin to notify the plugin
        $dom.showTitle.on('change', function() {
            // Update the global $settings proxy (auto-saves via action.js)
            $settings.showTitle = this.checked;

            // Send notification to plugin to update the button display
            $websocket.sendToPlugin({showTitle: this.checked});
        });
    },
    sendToPropertyInspector(data) {
    }
};
