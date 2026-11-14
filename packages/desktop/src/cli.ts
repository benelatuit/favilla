// The favilla and fav commands of the installed app: resources/bin/favilla.cmd runs Favilla.exe in Node mode
// (ELECTRON_RUN_AS_NODE) on this bundle, so the command comes with the app and needs no Node of its own.
// Imports run in order: the console and the app's paths are set up before the CLI's code loads.
import './cli-console';
import '../../cli/src/main';
