'use strict';

const EPS = 1e-6;
let action = null;

function fail(message) {
	Blockbench.showMessageBox({
		title: 'MinefiteTexture',
		icon: 'error',
		message,
		buttons: ['OK']
	});
}

function canvas(width, height) {
	const value = document.createElement('canvas');
	value.width = width;
	value.height = height;
	return value;
}

function setVector2(vector, x, y) {
	if (vector?.V2_set) {
		vector.V2_set(x, y);
	} else {
		vector[0] = x;
		vector[1] = y;
	}
}

function faceBounds(face) {
	const rect = face.getBoundingRect?.();

	if (rect && [rect.ax, rect.ay, rect.bx, rect.by].every(Number.isFinite)) {
		return {
			minU: Math.min(rect.ax, rect.bx),
			minV: Math.min(rect.ay, rect.by),
			maxU: Math.max(rect.ax, rect.bx),
			maxV: Math.max(rect.ay, rect.by)
		};
	}

	if (Array.isArray(face.uv)) {
		return {
			minU: Math.min(face.uv[0], face.uv[2]),
			minV: Math.min(face.uv[1], face.uv[3]),
			maxU: Math.max(face.uv[0], face.uv[2]),
			maxV: Math.max(face.uv[1], face.uv[3])
		};
	}

	if (!face.uv || typeof face.uv !== 'object') {
		return null;
	}

	let minU = Infinity;
	let minV = Infinity;
	let maxU = -Infinity;
	let maxV = -Infinity;

	for (const key in face.uv) {
		const uv = face.uv[key];

		if (!uv || uv.length < 2) {
			continue;
		}

		minU = Math.min(minU, uv[0]);
		minV = Math.min(minV, uv[1]);
		maxU = Math.max(maxU, uv[0]);
		maxV = Math.max(maxV, uv[1]);
	}

	return Number.isFinite(minU) ? {minU, minV, maxU, maxV} : null;
}

function pixelRect(bounds, info) {
	const left = bounds.minU * info.pxPerU;
	const top = bounds.minV * info.pxPerV;
	const right = bounds.maxU * info.pxPerU;
	const bottom = bounds.maxV * info.pxPerV;

	if (
		left < -EPS ||
		top < -EPS ||
		right > info.width + EPS ||
		bottom > info.height + EPS
	) {
		throw new Error('UV за пределами текстуры не поддерживаются');
	}

	const x = Math.max(0, Math.floor(left + EPS));
	const y = Math.max(0, Math.floor(top + EPS));
	const maxX = Math.min(info.width, Math.ceil(right - EPS));
	const maxY = Math.min(info.height, Math.ceil(bottom - EPS));

	return maxX > x && maxY > y
		? {x, y, w: maxX - x, h: maxY - y}
		: null;
}

function mergeRect(target, source) {
	if (!target) {
		return {...source};
	}

	const right = Math.max(target.x + target.w, source.x + source.w);
	const bottom = Math.max(target.y + target.h, source.y + source.h);

	target.x = Math.min(target.x, source.x);
	target.y = Math.min(target.y, source.y);
	target.w = right - target.x;
	target.h = bottom - target.y;

	return target;
}

function analyze(texture, info) {
	const mask = canvas(info.width, info.height);
	const maskCtx = mask.getContext('2d');
	const primitives = [];
	const elements = new Set();
	let hasBoxUV = false;

	maskCtx.fillStyle = '#fff';

	for (const element of Outliner.elements) {
		if (!element?.faces) {
			continue;
		}

		const cubeLike = element.getTypeBehavior?.('cube_faces') ??
			(typeof Cube !== 'undefined' && element instanceof Cube);

		if (cubeLike && element.box_uv) {
			let region = null;
			let selected = false;
			let foreign = false;

			for (const key in element.faces) {
				const face = element.faces[key];
				const faceTexture = face?.getTexture?.();

				if (!faceTexture) {
					continue;
				}

				if (faceTexture !== texture) {
					foreign = true;
					continue;
				}

				selected = true;

				const bounds = faceBounds(face);
				const rect = bounds && pixelRect(bounds, info);

				if (!rect) {
					continue;
				}

				maskCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
				region = mergeRect(region, rect);
			}

			if (!selected) {
				continue;
			}

			if (foreign) {
				throw new Error(
					`Box UV элемент «${element.name || element.uuid}» использует несколько текстур`
				);
			}

			if (!region) {
				continue;
			}

			primitives.push({
				...region,
				members: [{type: 'box', element}]
			});

			elements.add(element);
			hasBoxUV = true;
			continue;
		}

		for (const key in element.faces) {
			const face = element.faces[key];

			if (face?.getTexture?.() !== texture) {
				continue;
			}

			const meshFace = typeof Mesh !== 'undefined' && element instanceof Mesh;

			if (meshFace && face.vertices?.length <= 2) {
				continue;
			}

			const bounds = faceBounds(face);
			const rect = bounds && pixelRect(bounds, info);

			if (!rect) {
				continue;
			}

			if (meshFace && face.getOccupationMatrix) {
				const matrix = face.getOccupationMatrix(true, [0, 0]);

				for (const x in matrix) {
					for (const y in matrix[x]) {
						if (matrix[x][y]) {
							maskCtx.fillRect(Number(x), Number(y), 1, 1);
						}
					}
				}
			} else {
				maskCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
			}

			primitives.push({
				...rect,
				members: [{type: meshFace ? 'mesh' : 'face', element, face}]
			});

			elements.add(element);
		}
	}

	return {
		mask,
		primitives,
		elements: [...elements],
		hasBoxUV
	};
}

function cleanedSources(texture, mask) {
	const clean = source => {
		const result = canvas(source.width, source.height);
		const ctx = result.getContext('2d');

		ctx.drawImage(mask, 0, 0);
		ctx.globalCompositeOperation = 'source-in';
		ctx.drawImage(source, 0, 0);
		ctx.globalCompositeOperation = 'source-over';

		return result;
	};

	if (!texture.layers_enabled) {
		return [{target: texture, canvas: clean(texture.canvas)}];
	}

	return texture.layers.map(layer => {
		const normalized = canvas(texture.width, texture.height);
		const ctx = normalized.getContext('2d');
		const width = layer.blend_mode === 'alpha_mask'
			? layer.width
			: layer.scaled_width;
		const height = layer.blend_mode === 'alpha_mask'
			? layer.height
			: layer.scaled_height;

		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(
			layer.canvas,
			layer.offset[0],
			layer.offset[1],
			width,
			height
		);

		return {
			target: layer,
			canvas: clean(normalized)
		};
	});
}

function overlaps(a, b) {
	return (
		a.x < b.x + b.w &&
		a.x + a.w > b.x &&
		a.y < b.y + b.h &&
		a.y + a.h > b.y
	);
}

function islands(primitives) {
	const parent = primitives.map((_, index) => index);

	const find = index => {
		while (parent[index] !== index) {
			parent[index] = parent[parent[index]];
			index = parent[index];
		}

		return index;
	};

	const union = (a, b) => {
		a = find(a);
		b = find(b);

		if (a !== b) {
			parent[b] = a;
		}
	};

	for (let i = 0; i < primitives.length; i++) {
		for (let j = i + 1; j < primitives.length; j++) {
			if (overlaps(primitives[i], primitives[j])) {
				union(i, j);
			}
		}
	}

	const groups = new Map();

	primitives.forEach((primitive, index) => {
		const root = find(index);

		if (!groups.has(root)) {
			groups.set(root, []);
		}

		groups.get(root).push(primitive);
	});

	let id = 0;

	return [...groups.values()].map(group => {
		let rect = null;
		const members = [];

		for (const primitive of group) {
			rect = mergeRect(rect, primitive);
			members.push(...primitive.members);
		}

		return {
			id: id++,
			...rect,
			members
		};
	});
}

function contains(a, b) {
	return (
		b.x >= a.x &&
		b.y >= a.y &&
		b.x + b.w <= a.x + a.w &&
		b.y + b.h <= a.y + a.h
	);
}

function splitFree(free, used) {
	if (!overlaps(free, used)) {
		return [free];
	}

	const result = [];
	const freeRight = free.x + free.w;
	const freeBottom = free.y + free.h;
	const usedRight = used.x + used.w;
	const usedBottom = used.y + used.h;

	if (used.x > free.x) {
		result.push({
			x: free.x,
			y: free.y,
			w: used.x - free.x,
			h: free.h
		});
	}

	if (usedRight < freeRight) {
		result.push({
			x: usedRight,
			y: free.y,
			w: freeRight - usedRight,
			h: free.h
		});
	}

	if (used.y > free.y) {
		result.push({
			x: free.x,
			y: free.y,
			w: free.w,
			h: used.y - free.y
		});
	}

	if (usedBottom < freeBottom) {
		result.push({
			x: free.x,
			y: usedBottom,
			w: free.w,
			h: freeBottom - usedBottom
		});
	}

	return result.filter(rect => rect.w > 0 && rect.h > 0);
}

function prune(rectangles) {
	for (let i = 0; i < rectangles.length; i++) {
		for (let j = i + 1; j < rectangles.length; j++) {
			if (contains(rectangles[i], rectangles[j])) {
				rectangles.splice(j--, 1);
			} else if (contains(rectangles[j], rectangles[i])) {
				rectangles.splice(i--, 1);
				break;
			}
		}
	}

	return rectangles;
}

function packWidth(items, width) {
	const sorted = [...items].sort(
		(a, b) =>
			Math.max(b.w, b.h) - Math.max(a.w, a.h) ||
			b.w * b.h - a.w * a.h
	);

	const maxHeight = sorted.reduce((sum, item) => sum + item.h, 0);
	let free = [{x: 0, y: 0, w: width, h: maxHeight}];
	const positions = new Map();
	let usedWidth = 0;
	let usedHeight = 0;

	for (const item of sorted) {
		let best = -1;
		let score = null;

		for (let i = 0; i < free.length; i++) {
			const rect = free[i];

			if (item.w > rect.w || item.h > rect.h) {
				continue;
			}

			const candidate = [
				Math.min(rect.w - item.w, rect.h - item.h),
				Math.max(rect.w - item.w, rect.h - item.h),
				rect.y,
				rect.x
			];

			const better =
				!score ||
				candidate[0] < score[0] ||
				(candidate[0] === score[0] && candidate[1] < score[1]) ||
				(
					candidate[0] === score[0] &&
					candidate[1] === score[1] &&
					candidate[2] < score[2]
				) ||
				(
					candidate[0] === score[0] &&
					candidate[1] === score[1] &&
					candidate[2] === score[2] &&
					candidate[3] < score[3]
				);

			if (better) {
				best = i;
				score = candidate;
			}
		}

		if (best < 0) {
			return null;
		}

		const used = {
			x: free[best].x,
			y: free[best].y,
			w: item.w,
			h: item.h
		};

		positions.set(item.id, {
			x: used.x,
			y: used.y
		});

		free = prune(
			free.flatMap(rect => splitFree(rect, used))
		);

		usedWidth = Math.max(usedWidth, used.x + used.w);
		usedHeight = Math.max(usedHeight, used.y + used.h);
	}

	return {
		positions,
		width: usedWidth,
		height: usedHeight
	};
}

function bestPacking(items, preferredWidth) {
	const minWidth = Math.max(...items.map(item => item.w));
	const maxWidth = items.reduce((sum, item) => sum + item.w, 0);
	const totalArea = items.reduce((sum, item) => sum + item.w * item.h, 0);

	const candidates = new Set([
		minWidth,
		maxWidth,
		Math.min(maxWidth, Math.max(minWidth, preferredWidth)),
		Math.min(
			maxWidth,
			Math.max(minWidth, Math.ceil(Math.sqrt(totalArea)))
		)
	]);

	const step = Math.max(
		1,
		Math.ceil((maxWidth - minWidth) / 512)
	);

	for (let width = minWidth; width <= maxWidth; width += step) {
		candidates.add(width);
	}

	let best = null;

	for (const width of candidates) {
		const result = packWidth(items, width);

		if (!result) {
			continue;
		}

		const area = result.width * result.height;
		const balance = Math.abs(
			Math.log(result.width / Math.max(1, result.height))
		);
		const score = area * (1 + balance * 0.05);

		if (
			!best ||
			score < best.score ||
			(score === best.score && area < best.area)
		) {
			best = {
				...result,
				score,
				area
			};
		}
	}

	return best;
}

function preserveAspect(layout, ratio) {
	const byWidth = {
		width: layout.width,
		height: Math.ceil(layout.width / ratio)
	};

	const byHeight = {
		width: Math.ceil(layout.height * ratio),
		height: layout.height
	};

	const candidates = [byWidth, byHeight].filter(
		size =>
			size.width >= layout.width &&
			size.height >= layout.height
	);

	return candidates.sort(
		(a, b) => a.width * a.height - b.width * b.height
	)[0];
}

function repack(source, itemList, layout, width, height) {
	const target = canvas(width, height);
	const ctx = target.getContext('2d');

	ctx.imageSmoothingEnabled = false;

	for (const item of itemList) {
		const position = layout.positions.get(item.id);

		ctx.drawImage(
			source,
			item.x,
			item.y,
			item.w,
			item.h,
			position.x,
			position.y,
			item.w,
			item.h
		);
	}

	return target;
}

function transformUV(
	value,
	oldPixels,
	oldUV,
	offset,
	newPixels,
	newUV
) {
	return (
		(value * oldPixels / oldUV + offset) *
		newUV /
		newPixels
	);
}

function updateUV(
	itemList,
	layout,
	info,
	newWidth,
	newHeight,
	newUVWidth,
	newUVHeight
) {
	for (const item of itemList) {
		const position = layout.positions.get(item.id);
		const dx = position.x - item.x;
		const dy = position.y - item.y;

		for (const member of item.members) {
			if (member.type === 'box') {
				member.element.uv_offset[0] += dx / info.pxPerU;
				member.element.uv_offset[1] += dy / info.pxPerV;
				continue;
			}

			if (member.type === 'face') {
				const uv = member.face.uv;

				uv[0] = transformUV(
					uv[0],
					info.width,
					info.uvWidth,
					dx,
					newWidth,
					newUVWidth
				);

				uv[2] = transformUV(
					uv[2],
					info.width,
					info.uvWidth,
					dx,
					newWidth,
					newUVWidth
				);

				uv[1] = transformUV(
					uv[1],
					info.height,
					info.uvHeight,
					dy,
					newHeight,
					newUVHeight
				);

				uv[3] = transformUV(
					uv[3],
					info.height,
					info.uvHeight,
					dy,
					newHeight,
					newUVHeight
				);

				continue;
			}

			for (const key in member.face.uv) {
				const uv = member.face.uv[key];

				uv[0] = transformUV(
					uv[0],
					info.width,
					info.uvWidth,
					dx,
					newWidth,
					newUVWidth
				);

				uv[1] = transformUV(
					uv[1],
					info.height,
					info.uvHeight,
					dy,
					newHeight,
					newUVHeight
				);
			}
		}
	}
}

function refresh(texture, elements) {
	UVEditor.updateSelectionOutline?.();
	UVEditor.loadData?.();
	UVEditor.vue?.updateTexture?.();

	Canvas.updateView({
		elements,
		element_aspects: {
			uv: true
		}
	});

	TextureAnimator.updateButton?.();
	updateInterfacePanels?.();
	BARS.updateConditions?.();

	setTimeout(
		() => updateSelection?.(),
		50
	);
}

function run() {
	const texture = Texture.selected;

	if (!texture) {
		return;
	}

	if ((texture.frameCount || 1) > 1) {
		return fail('Анимированные текстуры не поддерживаются');
	}

	if (
		texture.layers_enabled &&
		texture.layers.some(layer => layer.in_limbo)
	) {
		return fail('Заверши активное преобразование слоя');
	}

	const info = {
		width: texture.width,
		height: texture.height,
		uvWidth: texture.getUVWidth(),
		uvHeight: texture.getUVHeight()
	};

	info.pxPerU = info.width / info.uvWidth;
	info.pxPerV = info.height / info.uvHeight;

	let data;
	let itemList;
	let layout;
	let sources;

	try {
		data = analyze(texture, info);

		if (!data.primitives.length) {
			throw new Error(
				'Выбранная текстура не используется моделью'
			);
		}

		itemList = islands(data.primitives);
		layout = bestPacking(itemList, info.width);

		if (!layout) {
			throw new Error('Не удалось разместить UV острова');
		}

		sources = cleanedSources(texture, data.mask);
	} catch (error) {
		console.error('[MinefiteTexture]', error);
		return fail(error.message || String(error));
	}

	const resizeUVSpace =
		Format.per_texture_uv_size ||
		Format.single_texture ||
		Texture.all.length === 1;

	if (data.hasBoxUV && !resizeUVSpace) {
		return fail(
			'Box UV нельзя безопасно уплотнить при общем UV размере нескольких текстур'
		);
	}

	let newWidth = layout.width;
	let newHeight = layout.height;

	if (!resizeUVSpace) {
		const size = preserveAspect(
			layout,
			info.uvWidth / info.uvHeight
		);

		newWidth = size.width;
		newHeight = size.height;
	}

	const newUVWidth = resizeUVSpace
		? info.uvWidth * newWidth / info.width
		: info.uvWidth;

	const newUVHeight = resizeUVSpace
		? info.uvHeight * newHeight / info.height
		: info.uvHeight;

	const packed = sources.map(source => ({
		target: source.target,
		canvas: repack(
			source.canvas,
			itemList,
			layout,
			newWidth,
			newHeight
		)
	}));

	const changesProjectUV =
		resizeUVSpace &&
		!Format.per_texture_uv_size;

	let editing = false;

	try {
		const aspects = {
			textures: [texture],
			bitmap: true,
			elements: data.elements
		};

		if (changesProjectUV) {
			aspects.uv_mode = true;
		}

		Undo.initEdit(aspects);
		editing = true;

		texture.width = newWidth;
		texture.height = newHeight;

		if (texture.layers_enabled) {
			for (const entry of packed) {
				const layer = entry.target;

				layer.setSize(newWidth, newHeight);
				layer.ctx.imageSmoothingEnabled = false;
				layer.ctx.drawImage(entry.canvas, 0, 0);

				setVector2(layer.offset, 0, 0);
				setVector2(layer.scale, 1, 1);
			}
		} else {
			texture.canvas.width = newWidth;
			texture.canvas.height = newHeight;
			texture.ctx.imageSmoothingEnabled = false;
			texture.ctx.drawImage(packed[0].canvas, 0, 0);
		}

		if (Format.per_texture_uv_size) {
			texture.uv_width = newUVWidth;
			texture.uv_height = newUVHeight;
		} else if (resizeUVSpace) {
			Project.texture_width = newUVWidth;
			Project.texture_height = newUVHeight;
			texture.uv_width = newUVWidth;
			texture.uv_height = newUVHeight;
		}

		updateUV(
			itemList,
			layout,
			info,
			newWidth,
			newHeight,
			newUVWidth,
			newUVHeight
		);

		texture.currentFrame = 0;
		texture.selection.changeSize(newWidth, newHeight);
		texture.selection.clear();
		texture.updateChangesAfterEdit();

		Undo.finishEdit('Clean and pack texture UV');
		editing = false;

		refresh(texture, data.elements);

		Blockbench.showQuickMessage(
			`${info.width}×${info.height} → ${newWidth}×${newHeight}`,
			3000
		);
	} catch (error) {
		console.error('[MinefiteTexture]', error);

		if (editing) {
			Undo.cancelEdit(true);
		}

		fail(error.message || String(error));
	}
}

Plugin.register('minefite_texture', {
	title: 'MinefiteTexture',
	author: 'soul1se',
	icon: 'view_compact',
	description: 'Специально для проекта Minefite',
	version: '0.0.1',
	min_version: '4.9.0',
	variant: 'both',

	onload() {
		action = new Action('minefite_texture_uv', {
			name: 'Оптимизация текстуры',
			icon: 'view_compact',
			category: 'textures',
			condition: {
				modes: ['paint', 'edit'],
				features: ['edit_mode'],
				method: () => Boolean(Texture.selected)
			},
			click: run
		});

		if (MenuBar.menus.image) {
			MenuBar.menus.image.addAction(action, '#transform');
		} else {
			MenuBar.menus.tools.addAction(action);
		}
	},

	onunload() {
		action?.delete();
		action = null;
	}
});