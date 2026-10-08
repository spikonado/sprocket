import typescript from 'devicon/icons/typescript/typescript-original.svg?raw';
import javascript from 'devicon/icons/javascript/javascript-original.svg?raw';
import python from 'devicon/icons/python/python-original.svg?raw';
import rust from 'devicon/icons/rust/rust-original.svg?raw';
import go from 'devicon/icons/go/go-original.svg?raw';
import c from 'devicon/icons/c/c-original.svg?raw';
import cplusplus from 'devicon/icons/cplusplus/cplusplus-original.svg?raw';
import csharp from 'devicon/icons/csharp/csharp-original.svg?raw';
import java from 'devicon/icons/java/java-original.svg?raw';
import kotlin from 'devicon/icons/kotlin/kotlin-original.svg?raw';
import swift from 'devicon/icons/swift/swift-original.svg?raw';
import ruby from 'devicon/icons/ruby/ruby-original.svg?raw';
import php from 'devicon/icons/php/php-original.svg?raw';
import dart from 'devicon/icons/dart/dart-original.svg?raw';
import html5 from 'devicon/icons/html5/html5-original.svg?raw';
import css3 from 'devicon/icons/css3/css3-original.svg?raw';
import sass from 'devicon/icons/sass/sass-original.svg?raw';
import bash from 'devicon/icons/bash/bash-original.svg?raw';
import powershell from 'devicon/icons/powershell/powershell-original.svg?raw';
import json from 'devicon/icons/json/json-original.svg?raw';
import yaml from 'devicon/icons/yaml/yaml-original.svg?raw';
import markdown from 'devicon/icons/markdown/markdown-original.svg?raw';
import lua from 'devicon/icons/lua/lua-original.svg?raw';
import r from 'devicon/icons/r/r-original.svg?raw';
import scala from 'devicon/icons/scala/scala-original.svg?raw';
import elixir from 'devicon/icons/elixir/elixir-original.svg?raw';
import haskell from 'devicon/icons/haskell/haskell-original.svg?raw';
import perl from 'devicon/icons/perl/perl-original.svg?raw';

const LANGUAGE_ICONS = [
	{ name: 'TypeScript', svg: typescript, languages: ['ts', 'tsx', 'typescript'] },
	{ name: 'JavaScript', svg: javascript, languages: ['js', 'jsx', 'javascript'] },
	{ name: 'Python', svg: python, languages: ['py', 'python'] },
	{ name: 'Rust', svg: rust, languages: ['rs', 'rust'], monochrome: true },
	{ name: 'Go', svg: go, languages: ['go', 'golang'] },
	{ name: 'C', svg: c, languages: ['c'] },
	{ name: 'C++', svg: cplusplus, languages: ['cpp', 'c++', 'cxx'] },
	{ name: 'C#', svg: csharp, languages: ['cs', 'c#', 'csharp'] },
	{ name: 'Java', svg: java, languages: ['java'] },
	{ name: 'Kotlin', svg: kotlin, languages: ['kt', 'kts', 'kotlin'] },
	{ name: 'Swift', svg: swift, languages: ['swift'] },
	{ name: 'Ruby', svg: ruby, languages: ['rb', 'ruby'] },
	{ name: 'PHP', svg: php, languages: ['php'] },
	{ name: 'Dart', svg: dart, languages: ['dart'] },
	{ name: 'HTML', svg: html5, languages: ['html', 'html5'] },
	{ name: 'CSS', svg: css3, languages: ['css', 'css3'] },
	{ name: 'Sass', svg: sass, languages: ['sass', 'scss'] },
	{ name: 'Bash', svg: bash, languages: ['bash', 'sh', 'shell', 'shellscript'] },
	{ name: 'PowerShell', svg: powershell, languages: ['ps', 'ps1', 'powershell'] },
	{ name: 'JSON', svg: json, languages: ['json', 'jsonc', 'json5'], monochrome: true },
	{ name: 'YAML', svg: yaml, languages: ['yaml', 'yml'] },
	{ name: 'Markdown', svg: markdown, languages: ['md', 'markdown'], monochrome: true },
	{ name: 'Lua', svg: lua, languages: ['lua'] },
	{ name: 'R', svg: r, languages: ['r'] },
	{ name: 'Scala', svg: scala, languages: ['scala'] },
	{ name: 'Elixir', svg: elixir, languages: ['elixir', 'ex'] },
	{ name: 'Haskell', svg: haskell, languages: ['haskell', 'hs'] },
	{ name: 'Perl', svg: perl, languages: ['perl', 'pl'] }
];

export default function CodeLanguageIcon({ language }: { language?: string }) {
	const name = language?.toLowerCase() || 'text';

	const icon = LANGUAGE_ICONS.find((entry) => entry.languages.includes(name));

	return (
		<span className="markdown-code-language" title={icon?.name || language || 'Plain text'}>
			{icon ? (
				<span
					className={
						icon.monochrome
							? 'markdown-code-language-icon monochrome'
							: 'markdown-code-language-icon'
					}
					role="img"
					aria-label={icon.name}
					dangerouslySetInnerHTML={{ __html: icon.svg }}
				/>
			) : (
				name
			)}
		</span>
	);
}
