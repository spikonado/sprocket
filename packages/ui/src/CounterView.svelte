<script lang="ts">
	import { newCounter } from '$ui/counter.svelte';

	let _counter = newCounter();
</script>

<button onclick={() => _counter.decrement()}>-</button>

Current count: {_counter.count}

<button onclick={() => _counter.increment()}>+</button>
