/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

const $local = true, $back = false, $dom = {
    main: $('.sdpi-wrapper'),
    refreshRate: $('#refreshRate'),
    refreshValue: $('#refreshValue'),
    showArtist: $('#showArtist'),
    showAlbum: $('#showAlbum')
};

const $propEvent = {
    didReceiveGlobalSettings({ settings }) {
    },
    didReceiveSettings(data) {
        $dom.refreshRate.on('input', function() {
            $dom.refreshValue.textContent = this.value + 'ms';
        });
        $dom.refreshRate.on('change', function() {
            $settings.refreshRate = parseInt(this.value);
        });
        $dom.showArtist.on('change', function() {
            $settings.showArtist = this.checked;
        });
        $dom.showAlbum.on('change', function() {
            $settings.showAlbum = this.checked;
        });

        $dom.refreshRate.value = $settings.refreshRate || 1000;
        $dom.refreshValue.textContent = ($settings.refreshRate || 1000) + 'ms';
        $dom.showArtist.checked = $settings.showArtist !== false;
        $dom.showAlbum.checked = $settings.showAlbum !== false;
    },
    sendToPropertyInspector(data) {
    }
};
