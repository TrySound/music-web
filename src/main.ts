import { mount } from 'svelte';
import App from './app.svelte';
import './app.css';

const target = document.getElementById('app');

if (!target) {
  throw new Error('App target was not found.');
}

mount(App, { target });
