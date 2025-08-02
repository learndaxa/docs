// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidatorPlugin from 'starlight-links-validator';
import starlightSidebarTopicsPlugin from 'starlight-sidebar-topics';
import astroD2 from 'astro-d2'
import { walkDocsRecursive } from './listSidebar';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightScrollToTop from 'starlight-scroll-to-top';

const prod = process.env.NODE_ENV === "production";

// https://astro.build/config
export default defineConfig({
	site: "https://docs.daxa.dev",
	integrations: [
		astroD2({
			skipGeneration: !prod,
		}),
		starlight({
			title: 'Docs',
			favicon: '/favicon.png',
			logo: {
				src: './src/assets/daxa-logo-64p.png',
				replacesTitle: false
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/Ipotrick/Daxa'
				},
				{
					icon: "discord",
					label: "Discord",
					href: "https://discord.gg/mZrUeJfxB8"
				},
			],
			expressiveCode: {
				frames: {
					extractFileNameFromCode: false,
				},
				emitExternalStylesheet: false,
			},
			plugins: [
				starlightScrollToTop(),
				starlightLlmsTxt(),
				starlightLinksValidatorPlugin(),
				starlightSidebarTopicsPlugin(
					[
						{
							id: 'tutorial',
							label: 'Tutorial',
							link: '/tutorial/',
							icon: 'document',
							items: walkDocsRecursive('src/content/docs/tutorial/')
						},
						{
							id: 'wiki',
							label: 'Wiki',
							link: '/wiki/',
							icon: 'open-book',
							items: walkDocsRecursive('src/content/docs/wiki/')
						}
					],
					{
						topics: {
							
						}
					}
				)
			],
			components: {
				Sidebar: './src/components/Sidebar.astro',
				Head: './src/components/Head.astro',
			},
			lastUpdated: true,
			editLink: {
				baseUrl: "https://github.com/learndaxa/docs/edit/main/",
			},
			customCss: [
				'./src/custom.css'
			],
			head: [
				{
					tag: 'meta',
					attrs: {
						name: 'theme-color',
						content: '#8467b6'
					}
				}
			]
		}),
	],
	build: {
		inlineStylesheets: "always",
	},
	image: {
		responsiveStyles: true,
		layout: "constrained",
	}
});
