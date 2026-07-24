// Bridge that lets the parent page (Junicoders app) save and resume a
// student's Scratch project across sessions via postMessage, since the
// stock scratch-gui has no such hook when embedded in an iframe.
import {vmInitialState} from '../reducers/vm.js';

const vm = vmInitialState;

const uint8ToBase64 = bytes => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return window.btoa(binary);
};

const base64ToUint8 = base64 => {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

let saveTimer = null;

const sendSave = () => {
    vm.saveProjectSb3()
        .then(blob => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = uint8ToBase64(new Uint8Array(reader.result));
                let code = '';
                try {
                    // Textual snapshot of the project's blocks (opcodes, field values, variable
                    // names) used by the parent app to verify a challenge's required block/keyword.
                    code = JSON.stringify(vm.toJSON());
                } catch (e) {
                    // ignore; verification will simply not match
                }
                window.parent.postMessage({type: 'JUNI_SAVE_PROJECT', payload: base64, code}, '*');
            };
            reader.readAsArrayBuffer(blob);
        })
        .catch(() => {
            // ignore transient save failures (e.g. mid-load)
        });
};

const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(sendSave, 4000);
};

let initialSnapshotSent = false;
let loadInProgress = false;

// Snapshot the true starting state (blank, or resumed) so the parent app can
// tell "did the student actually change anything" apart from whatever the
// first debounced PROJECT_CHANGED save happens to capture — without this,
// several quick edits made before that first save fires all get folded into
// the comparison baseline instead of counting as real work.
const sendInitialSnapshot = () => {
    if (initialSnapshotSent) return;
    initialSnapshotSent = true;
    let code = '';
    try {
        code = JSON.stringify(vm.toJSON());
    } catch (e) {
        // ignore; baseline will simply not be set
    }
    window.parent.postMessage({type: 'JUNI_INITIAL_CODE', code}, '*');
};

window.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'JUNI_LOAD_PROJECT' && data.payload) {
        loadInProgress = true;
        vm.loadProject(base64ToUint8(data.payload))
            .catch(() => {})
            .then(() => sendInitialSnapshot());
    }
});

vm.runtime.on('PROJECT_CHANGED', scheduleSave);

// Let the parent know it's safe to send a saved project now.
window.parent.postMessage({type: 'JUNI_SCRATCH_READY'}, '*');

// If the parent doesn't send a saved project to resume (starting fresh),
// snapshot the blank starting state shortly after ready.
setTimeout(() => {
    if (!loadInProgress) sendInitialSnapshot();
}, 300);
