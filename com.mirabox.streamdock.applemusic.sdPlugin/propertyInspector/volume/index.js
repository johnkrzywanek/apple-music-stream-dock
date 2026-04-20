/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

const $local = true, $back = false, $dom = {
    main: $('.sdpi-wrapper'),
    volumeStep: $('#volumeStep'),
    stepValue: $('#stepValue'),
    showVolume: $('#showVolume'),
    muteButton: $('#muteButton')
};

const $propEvent = {
    didReceiveGlobalSettings({ settings }) {
    },
    didReceiveSettings(data) {
        $dom.volumeStep.on('input', function() {
            $settings.volumeStep = parseInt(this.value);
            $dom.stepValue.textContent = this.value + '%';
        });
        $dom.volumeStep.on('change', function() {
            $settings.volumeStep = parseInt(this.value);
        });
        $dom.showVolume.on('change', function() {
            $settings.showVolume = this.checked;
        });
        $dom.muteButton.on('change', function() {
            $settings.muteButton = this.checked;
        });

        $dom.volumeStep.value = $settings.volumeStep || 5;
        $dom.stepValue.textContent = ($settings.volumeStep || 5) + '%';
        $dom.showVolume.checked = $settings.showVolume !== false;
        $dom.muteButton.checked = $settings.muteButton !== false;
    },
    sendToPropertyInspector(data) {
    }
};
